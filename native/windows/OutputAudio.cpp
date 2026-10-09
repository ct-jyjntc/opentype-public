// A process-scoped Core Audio lease. stdin EOF releases it even when Electron
// crashes; a protected journal records intent before every output mutation.
#include "PrivateStorage.h"
#include <mmdeviceapi.h>
#include <endpointvolume.h>
#include <wrl/client.h>
#include <atomic>
#include <map>
#include <set>
#include <thread>
#include <cmath>
#include <cstring>
#include <algorithm>
#include <cstdint>

using Microsoft::WRL::ComPtr;
namespace {
struct AudioUnavailable:std::runtime_error { using std::runtime_error::runtime_error; };
struct MutexOwnership {
  HANDLE mutex;
  explicit MutexOwnership(HANDLE value):mutex(value){}
  ~MutexOwnership(){ReleaseMutex(mutex);}
  MutexOwnership(const MutexOwnership&)=delete;
};
constexpr float epsilon=0.0005f;
constexpr size_t maximumEntries=256;
bool closeValue(float a,float b){return std::isfinite(a)&&std::isfinite(b)&&std::abs(a-b)<=epsilon;}
std::wstring decode(const BYTE* bytes,size_t count){
  if(!count||count>8192)throw std::runtime_error("bad_endpoint_id");
  int size=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,reinterpret_cast<const char*>(bytes),static_cast<int>(count),nullptr,0);
  if(!size)throw std::runtime_error("bad_endpoint_id");std::wstring text(size,L'\0');
  MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,reinterpret_cast<const char*>(bytes),static_cast<int>(count),text.data(),size);
  if(text.find(L'\0')!=std::wstring::npos)throw std::runtime_error("bad_endpoint_id");return text;
}
std::vector<BYTE> encode(const std::wstring& text){
  int size=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0,nullptr,nullptr);
  if(!size||size>8192)throw std::runtime_error("bad_endpoint_id");std::vector<BYTE> bytes(size);
  WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),reinterpret_cast<char*>(bytes.data()),size,nullptr,nullptr);return bytes;
}
void number(std::vector<BYTE>& out,uint32_t value){for(int i=0;i<4;i++)out.push_back(static_cast<BYTE>(value>>(8*i)));}
void scalar(std::vector<BYTE>& out,float value){uint32_t bits;memcpy(&bits,&value,4);number(out,bits);}
uint32_t checksum(const BYTE* bytes,size_t size){uint32_t crc=~0u;for(size_t n=0;n<size;n++){crc^=bytes[n];for(int bit=0;bit<8;bit++)crc=(crc>>1)^((crc&1)?0xedb88320u:0);}return ~crc;}
struct Entry{
  std::wstring id;
  bool mute=false;
  float previous=0,applied=0;
  // 0: written intent, 1: confirmed applied value, 2: user took ownership.
  uint32_t state=0;
};
class Journal{
  const otprivate::UserAccess& access;
  std::wstring path;
public:
  std::vector<Entry> entries;
  bool needsCleanup=false;
  explicit Journal(const otprivate::UserAccess& user):access(user),path(otprivate::directory(user,L"dev.opentype.output")+L"\\lease.bin"){
    bool exists=false;auto data=otprivate::read(user,path,3*1024*1024,exists);if(!exists)return;
    size_t offset=8;
    auto next=[&](){if(offset+4>data.size())throw std::runtime_error("bad_output_journal");uint32_t value=0;for(int i=0;i<4;i++)value|=static_cast<uint32_t>(data[offset++])<<(8*i);return value;};
    if(data.size()<16||memcmp(data.data(),"OTAU0001",8)!=0)throw std::runtime_error("bad_output_journal");
    auto count=next();if(count>maximumEntries)throw std::runtime_error("bad_output_journal");std::set<std::wstring> ids;
    for(uint32_t i=0;i<count;i++){
      uint32_t bytes=next();if(!bytes||bytes>8192||offset+bytes>data.size())throw std::runtime_error("bad_output_journal");
      Entry entry;entry.id=decode(data.data()+offset,bytes);offset+=bytes;
      uint32_t kind=next(),previous=next(),applied=next();entry.state=next();entry.mute=kind==1;
      memcpy(&entry.previous,&previous,4);memcpy(&entry.applied,&applied,4);
      if(kind>1||entry.state>2||!std::isfinite(entry.previous)||!std::isfinite(entry.applied)||entry.previous<0||entry.previous>1||entry.applied<0||entry.applied>1
          ||(entry.mute&&((entry.previous!=0&&entry.previous!=1)||(entry.applied!=0&&entry.applied!=1)))||!ids.insert(entry.id).second)throw std::runtime_error("bad_output_journal");
      entries.push_back(std::move(entry));
    }
    if(offset+4!=data.size())throw std::runtime_error("bad_output_journal");auto expected=checksum(data.data(),offset);if(next()!=expected)throw std::runtime_error("bad_output_journal");
    needsCleanup=entries.empty();
  }
  bool persist(){
    std::vector<BYTE> data={'O','T','A','U','0','0','0','1'};number(data,static_cast<uint32_t>(entries.size()));
    for(const auto& entry:entries){auto id=encode(entry.id);number(data,static_cast<uint32_t>(id.size()));data.insert(data.end(),id.begin(),id.end());
      number(data,entry.mute?1:0);scalar(data,entry.previous);scalar(data,entry.applied);number(data,entry.state);}
    number(data,checksum(data.data(),data.size()));
    if(!otprivate::write(access,path,data))return false;
    // A failed removal keeps a valid empty journal, retried on the next launch.
    if(entries.empty()&&!DeleteFileW(path.c_str())&&GetLastError()!=ERROR_FILE_NOT_FOUND)return false;
    return true;
  }
};
struct Signal{
  otprivate::Handle changed{CreateEventW(nullptr,FALSE,FALSE,nullptr)};
  void notify(){if(changed)SetEvent(changed.get());}
};
struct EndpointState{
  std::atomic_bool external{false};
  std::atomic<float> expected{0};
  bool mute=false;
  GUID context{};
  std::shared_ptr<Signal> signal;
};
class VolumeCallback final:public IAudioEndpointVolumeCallback{
  std::atomic<ULONG> references{1};std::shared_ptr<EndpointState> state;
public:
  explicit VolumeCallback(std::shared_ptr<EndpointState> value):state(std::move(value)){}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id,void** out)override{if(!out)return E_POINTER;*out=nullptr;if(id==IID_IUnknown||id==__uuidof(IAudioEndpointVolumeCallback)){*out=static_cast<IAudioEndpointVolumeCallback*>(this);AddRef();return S_OK;}return E_NOINTERFACE;}
  ULONG STDMETHODCALLTYPE AddRef()override{return ++references;}
  ULONG STDMETHODCALLTYPE Release()override{ULONG left=--references;if(!left)delete this;return left;}
  HRESULT STDMETHODCALLTYPE OnNotify(PAUDIO_VOLUME_NOTIFICATION_DATA data)override{
    if(data&&!IsEqualGUID(data->guidEventContext,state->context)){
      float value=state->mute?(data->bMuted?1.0f:0.0f):data->fMasterVolume;
      if(!closeValue(value,state->expected.load())){state->external=true;state->signal->notify();}
    }return S_OK;
  }
};
class DeviceCallback final:public IMMNotificationClient{
  std::atomic<ULONG> references{1};std::shared_ptr<Signal> signal;
public:
  explicit DeviceCallback(std::shared_ptr<Signal> value):signal(std::move(value)){}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id,void** out)override{if(!out)return E_POINTER;*out=nullptr;if(id==IID_IUnknown||id==__uuidof(IMMNotificationClient)){*out=static_cast<IMMNotificationClient*>(this);AddRef();return S_OK;}return E_NOINTERFACE;}
  ULONG STDMETHODCALLTYPE AddRef()override{return ++references;}
  ULONG STDMETHODCALLTYPE Release()override{ULONG left=--references;if(!left)delete this;return left;}
  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow,ERole,LPCWSTR)override{if(flow==eRender)signal->notify();return S_OK;}
  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR,DWORD)override{signal->notify();return S_OK;}
  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR)override{signal->notify();return S_OK;}
  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR)override{signal->notify();return S_OK;}
  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR,const PROPERTYKEY)override{signal->notify();return S_OK;}
};
struct Endpoint{
  ComPtr<IAudioEndpointVolume> volume;
  ComPtr<VolumeCallback> callback;
  std::shared_ptr<EndpointState> state;
  ~Endpoint(){if(volume&&callback)volume->UnregisterControlChangeNotify(callback.Get());}
};
class Lease{
  Journal journal;
  std::wstring mode;
  ComPtr<IMMDeviceEnumerator> devices;
  ComPtr<DeviceCallback> deviceCallback;
  std::map<std::wstring,std::unique_ptr<Endpoint>> owned;
  std::set<std::wstring> ignored;
  std::set<std::wstring> failed;
  GUID context{};
  bool dirty=false,storageFailed=false;
  std::string lastNotice="initial";
  bool lastPending=false;
  std::shared_ptr<Signal> signal;
  ComPtr<IAudioEndpointVolume> volume(const std::wstring& id){
    ComPtr<IMMDevice> device;ComPtr<IMMEndpoint> endpoint;ComPtr<IAudioEndpointVolume> value;DWORD state=0;EDataFlow flow=eAll;
    if(!devices||FAILED(devices->GetDevice(id.c_str(),&device))||FAILED(device->GetState(&state))||state!=DEVICE_STATE_ACTIVE
      ||FAILED(device.As(&endpoint))||FAILED(endpoint->GetDataFlow(&flow))||flow!=eRender)return value;
    device->Activate(__uuidof(IAudioEndpointVolume),CLSCTX_ALL,nullptr,&value);return value;
  }
  bool read(IAudioEndpointVolume* volume,const Entry& entry,float& value){
    if(!volume)return false;
    if(entry.mute){BOOL muted=FALSE;if(FAILED(volume->GetMute(&muted)))return false;value=muted?1.0f:0.0f;return true;}
    return SUCCEEDED(volume->GetMasterVolumeLevelScalar(&value))&&std::isfinite(value)&&value>=0&&value<=1;
  }
  bool write(IAudioEndpointVolume* volume,const Entry& entry,float value){return volume&&SUCCEEDED(entry.mute?volume->SetMute(value!=0,&context):volume->SetMasterVolumeLevelScalar(value,&context));}
  bool save(){
    if(!dirty)return !storageFailed;
    if(!journal.persist()){storageFailed=true;notice("output_audio_storage_error");return false;}
    dirty=false;storageFailed=false;return true;
  }
  bool has(const std::wstring& id)const{return std::any_of(journal.entries.begin(),journal.entries.end(),[&](const Entry& entry){return entry.id==id;});}
  bool waiting()const{return std::any_of(journal.entries.begin(),journal.entries.end(),[&](const Entry& entry){return entry.state!=2&&owned.find(entry.id)==owned.end();});}
  void relinquish(){
    for(auto iterator=owned.begin();iterator!=owned.end();){
      auto& owner=*iterator->second;float current=0;
      auto entry=std::find_if(journal.entries.begin(),journal.entries.end(),[&](const Entry& value){return value.id==iterator->first;});
      bool changed=owner.state->external.load()||(entry!=journal.entries.end()&&read(owner.volume.Get(),*entry,current)&&!closeValue(current,entry->applied));
      if(!changed){++iterator;continue;}
      if(entry!=journal.entries.end()){entry->state=2;dirty=true;}
      ignored.insert(iterator->first);iterator=owned.erase(iterator);notice("output_audio_changed");
    }
    save();
  }
public:
  Lease(const otprivate::UserAccess& user,std::wstring choice,std::shared_ptr<Signal> events):journal(user),mode(std::move(choice)),signal(std::move(events)){
    dirty=journal.needsCleanup;
    if(FAILED(CoCreateGuid(&context)))throw AudioUnavailable("audio_context_unavailable");
    if(FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_ALL,IID_PPV_ARGS(&devices))))throw AudioUnavailable("audio_service_unavailable");
    deviceCallback.Attach(new DeviceCallback(signal));devices->RegisterEndpointNotificationCallback(deviceCallback.Get());
  }
  ~Lease(){owned.clear();if(devices&&deviceCallback)devices->UnregisterEndpointNotificationCallback(deviceCallback.Get());}
  void notice(const char* detail){
    bool pending=waiting();if(lastNotice==detail&&lastPending==pending)return;lastNotice=detail;lastPending=pending;
    std::string output="{\"notice\":\""+lastNotice+"\",\"pending\":"+(pending?"true":"false")+"}\n";
    DWORD written=0;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),output.data(),static_cast<DWORD>(output.size()),&written,nullptr);
  }
  void restore(const std::set<std::wstring>& keep={}){
    relinquish();
    std::vector<Entry> pending;
    for(auto entry:journal.entries){
      if(entry.state==2){dirty=true;continue;}
      if(keep.count(entry.id)&&owned.count(entry.id)){pending.push_back(entry);continue;}
      auto found=owned.find(entry.id);auto currentVolume=volume(entry.id);float current=0;
      if(!read(currentVolume.Get(),entry,current)){pending.push_back(entry);owned.erase(entry.id);continue;}
      if(found!=owned.end()&&found->second->state->external.load()){ignored.insert(entry.id);dirty=true;owned.erase(entry.id);continue;}
      if(closeValue(current,entry.previous)){dirty=true;owned.erase(entry.id);continue;}
      if(!closeValue(current,entry.applied)){ignored.insert(entry.id);dirty=true;owned.erase(entry.id);continue;}
      if(found!=owned.end())found->second->state->expected=entry.previous;
      // Recheck the scalar immediately before the restore; a user's intervening
      // change must not be replaced just because the journal still exists.
      float before=0;
      if(!read(currentVolume.Get(),entry,before)){pending.push_back(entry);owned.erase(entry.id);continue;}
      if(!closeValue(before,entry.applied)||(found!=owned.end()&&found->second->state->external.load())){ignored.insert(entry.id);dirty=true;owned.erase(entry.id);continue;}
      if(write(currentVolume.Get(),entry,entry.previous)){
        float after=0;
        if(read(currentVolume.Get(),entry,after)&&closeValue(after,entry.previous)){dirty=true;owned.erase(entry.id);continue;}
      }
      pending.push_back(entry);owned.erase(entry.id);
    }
    journal.entries=std::move(pending);save();
  }
  void tick(){
    // A failed write never permits another mutation with an unrecorded baseline.
    if(!save())return;
    relinquish();if(storageFailed)return;
    std::set<std::wstring> desired;
    for(ERole role:{eConsole,eMultimedia,eCommunications}){
      ComPtr<IMMDevice> device;LPWSTR id=nullptr;
      if(SUCCEEDED(devices->GetDefaultAudioEndpoint(eRender,role,&device))&&SUCCEEDED(device->GetId(&id))){desired.insert(id);CoTaskMemFree(id);}
    }
    restore(desired);if(storageFailed)return;
    bool unavailable=desired.empty()||std::any_of(desired.begin(),desired.end(),[&](const std::wstring& id){return failed.count(id)!=0;});
    for(const auto& id:desired){
      if(owned.count(id)||ignored.count(id)||has(id))continue;
      if(journal.entries.size()>=maximumEntries){unavailable=true;continue;}
      auto current=volume(id);Entry entry;entry.id=id;entry.mute=mode==L"mute";
      if(!read(current.Get(),entry,entry.previous)){unavailable=true;continue;}
      entry.applied=entry.mute?1.0f:entry.previous*0.2f;
      if(closeValue(entry.previous,entry.applied)){ignored.insert(id);continue;}
      auto owner=std::make_unique<Endpoint>();owner->volume=current;owner->state=std::make_shared<EndpointState>();
      owner->state->context=context;owner->state->mute=entry.mute;owner->state->expected=entry.previous;owner->state->signal=signal;
      owner->callback.Attach(new VolumeCallback(owner->state));
      if(FAILED(current->RegisterControlChangeNotify(owner->callback.Get()))){unavailable=true;continue;}
      journal.entries.push_back(entry);dirty=true;
      if(!save())return; // Disk baseline is durable before SetMute/SetVolume.
      float before=0;
      if(!read(current.Get(),entry,before)||!closeValue(before,entry.previous)||owner->state->external.load()){
        journal.entries.back().state=2;dirty=true;ignored.insert(id);if(!save())return;continue;
      }
      owner->state->expected=entry.applied;
      bool applied=write(current.Get(),entry,entry.applied);float actual=0;
      if(applied&&read(current.Get(),entry,actual)&&!owner->state->external.load()){
        // The endpoint can quantize volume. Keep its actual returned value for
        // subsequent ownership checks instead of assuming the requested float.
        journal.entries.back().applied=actual;journal.entries.back().state=1;owner->state->expected=actual;
        owned[id]=std::move(owner);dirty=true;if(!save())return;
      }else{
        if(owner->state->external.load()){journal.entries.back().state=2;dirty=true;notice("output_audio_changed");}
        else{unavailable=true;failed.insert(id);}
        ignored.insert(id);restore(desired);if(storageFailed)return;
      }
    }
    if(unavailable)notice("output_audio_unavailable");
    else if(waiting())notice("output_audio_restore_pending");
    else if(ignored.size()&&lastNotice=="output_audio_changed")notice("output_audio_changed");
    else notice("");
  }
  void stop(){restore();if(storageFailed)notice("output_audio_storage_error");else notice(journal.entries.empty()?"":"output_audio_restore_pending");}
};
std::atomic<HANDLE> controlStop{nullptr},controlDone{nullptr};
std::atomic_uint controlCallbacks{0};
BOOL WINAPI consoleControl(DWORD type){
  if(type!=CTRL_C_EVENT&&type!=CTRL_BREAK_EVENT&&type!=CTRL_CLOSE_EVENT&&type!=CTRL_LOGOFF_EVENT&&type!=CTRL_SHUTDOWN_EVENT)return FALSE;
  controlCallbacks++;
  HANDLE stop=controlStop.load(),done=controlDone.load();
  if(stop)SetEvent(stop);
  if(done&&(type==CTRL_CLOSE_EVENT||type==CTRL_LOGOFF_EVENT||type==CTRL_SHUTDOWN_EVENT))WaitForSingleObject(done,2000);
  controlCallbacks--;
  return TRUE;
}
struct ConsoleRegistration{
  HANDLE done;
  ConsoleRegistration(HANDLE stop,HANDLE completed):done(completed){controlStop=stop;controlDone=done;SetConsoleCtrlHandler(consoleControl,TRUE);}
  ~ConsoleRegistration(){
    SetEvent(done);SetConsoleCtrlHandler(consoleControl,FALSE);controlStop=nullptr;controlDone=nullptr;
    // A queued handler that starts later sees null handles; handlers already
    // using them finish before the owning Handle objects are destroyed.
    while(controlCallbacks.load())Sleep(1);
  }
};
void failure(const char* notice){std::string out="{\"notice\":\""+std::string(notice)+"\"}\n";DWORD written;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),out.data(),static_cast<DWORD>(out.size()),&written,nullptr);}
}

int wmain(int argc,wchar_t** argv){
  if(argc!=2||(wcscmp(argv[1],L"duck")&&wcscmp(argv[1],L"mute")&&wcscmp(argv[1],L"recover")))return 2;
  HRESULT initialized=CoInitializeEx(nullptr,COINIT_MULTITHREADED);if(FAILED(initialized)){failure("output_audio_unavailable");return 1;}
  int result=0;
  try{
    otprivate::UserAccess user;auto security=user.attributes();
    std::wstring name=L"Local\\OpenType.OutputAudio."+user.sid();otprivate::Handle mutex(CreateMutexW(&security,FALSE,name.c_str()));
    DWORD acquired=mutex?WaitForSingleObject(mutex.get(),0):WAIT_FAILED;
    if(acquired!=WAIT_OBJECT_0&&acquired!=WAIT_ABANDONED){failure(acquired==WAIT_TIMEOUT?"output_audio_busy":"output_audio_storage_error");result=3;}
    else{
      MutexOwnership ownership(mutex.get());
      auto signal=std::make_shared<Signal>();otprivate::Handle stop(CreateEventW(nullptr,TRUE,FALSE,nullptr)),done(CreateEventW(nullptr,TRUE,FALSE,nullptr));
      if(!signal->changed||!stop||!done)throw AudioUnavailable("audio_event_unavailable");
      ConsoleRegistration controls(stop.get(),done.get());
      {
        Lease lease(user,argv[1],signal);lease.restore();
        if(wcscmp(argv[1],L"recover")==0)lease.stop();
        else{
          std::thread input([event=stop.get()]{
            // Poll the inherited pipe so shutdown cannot race a thread that has
            // not entered ReadFile yet. No unbounded read needs cancellation.
            char buffer[32];HANDLE source=GetStdHandle(STD_INPUT_HANDLE);
            if(GetFileType(source)!=FILE_TYPE_PIPE){SetEvent(event);return;}
            while(WaitForSingleObject(event,0)!=WAIT_OBJECT_0){
              DWORD available=0,received=0;
              if(!PeekNamedPipe(source,nullptr,0,nullptr,&available,nullptr)){SetEvent(event);return;}
              if(available){
                if(!ReadFile(source,buffer,std::min<DWORD>(available,sizeof(buffer)),&received,nullptr)||!received){SetEvent(event);return;}
              }else if(WaitForSingleObject(event,100)==WAIT_OBJECT_0)return;
            }
          });
          try{
            lease.tick();HANDLE events[]={stop.get(),signal->changed.get()};
            while(WaitForSingleObject(stop.get(),0)!=WAIT_OBJECT_0){
              DWORD wake=WaitForMultipleObjects(2,events,FALSE,300);
              if(wake==WAIT_OBJECT_0||wake==WAIT_FAILED)break;lease.tick();
            }
            lease.stop();
          }catch(...){try{lease.stop();}catch(...){}SetEvent(stop.get());input.join();throw;}
          SetEvent(stop.get());input.join();
        }
      }
      SetEvent(done.get());
    }
  }catch(const AudioUnavailable&){failure("output_audio_unavailable");result=1;}
  catch(...){failure("output_audio_storage_error");result=1;}
  CoUninitialize();return result;
}
