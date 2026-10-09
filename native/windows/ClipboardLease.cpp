#include "ClipboardLease.h"
#include "ClipboardProtocol.h"
#include "PrivateStorage.h"
#include <vector>
#include <cstring>
#include <stdexcept>
#include <array>
#include <new>

namespace otclip {
namespace {
void fail(){throw std::runtime_error("injection_clipboard_unavailable");}
std::wstring executable(){
  HMODULE module=nullptr;
  if(!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    reinterpret_cast<LPCWSTR>(&executable),&module))fail();
  std::wstring path(32768,L'\0');DWORD size=GetModuleFileNameW(module,path.data(),static_cast<DWORD>(path.size()));
  if(!size||size>=path.size())fail();path.resize(size);
  auto slash=path.find_last_of(L"\\/");if(slash==std::wstring::npos)fail();
  return path.substr(0,slash+1)+L"ClipboardGuard.exe";
}
struct Attributes{
  std::vector<BYTE> storage;
  LPPROC_THREAD_ATTRIBUTE_LIST list=nullptr;
  Attributes(){SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,1,0,&size);storage.resize(size);
    list=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if(!InitializeProcThreadAttributeList(list,1,0,&size)){list=nullptr;fail();}}
  ~Attributes(){if(list)DeleteProcThreadAttributeList(list);}
};
}
struct Lease::State{
  HANDLE mapping=nullptr,process=nullptr,parent=nullptr;
  std::array<HANDLE,5> events{}; // ready, apply, applied, restore, posted
  Packet* packet=nullptr;
  bool requested=false;
  ~State(){
    if(events[3])SetEvent(events[3]);
    if(packet)UnmapViewOfFile(packet);
    for(auto event:events)if(event)CloseHandle(event);
    if(parent)CloseHandle(parent);if(mapping)CloseHandle(mapping);if(process)CloseHandle(process);
  }
  void response(Result expected){
    LONG result=InterlockedCompareExchange(&packet->result,0,0);
    if(result==changed)throw std::runtime_error("injection_clipboard_changed");
    if(result!=expected)fail();
  }
};
Lease::Lease(const std::wstring& text,const std::string& html):state(std::make_unique<State>()){
  if(text.empty()||text.size()>maximumPayload/sizeof(wchar_t)||html.size()>maximumPayload)fail();
  size_t textSize=text.size()*sizeof(wchar_t),size=sizeof(Packet)+textSize+html.size();
  if(textSize+html.size()>maximumPayload)fail();
  otprivate::UserAccess user;auto access=user.attributes();access.bInheritHandle=TRUE;
  state->mapping=CreateFileMappingW(INVALID_HANDLE_VALUE,&access,PAGE_READWRITE,0,static_cast<DWORD>(size),nullptr);
  if(!state->mapping)fail();
  state->packet=static_cast<Packet*>(MapViewOfFile(state->mapping,FILE_MAP_READ|FILE_MAP_WRITE,0,0,size));if(!state->packet)fail();
  auto* packet=state->packet;new(packet) Packet;
  packet->originalSequence=GetClipboardSequenceNumber();packet->textBytes=static_cast<uint32_t>(textSize);packet->htmlBytes=static_cast<uint32_t>(html.size());
  memcpy(packet+1,text.data(),textSize);memcpy(reinterpret_cast<BYTE*>(packet+1)+textSize,html.data(),html.size());
  for(auto& event:state->events){event=CreateEventW(&access,TRUE,FALSE,nullptr);if(!event)fail();}
  if(!DuplicateHandle(GetCurrentProcess(),GetCurrentProcess(),GetCurrentProcess(),&state->parent,SYNCHRONIZE,TRUE,0))fail();
  std::vector<HANDLE> handles{state->mapping};handles.insert(handles.end(),state->events.begin(),state->events.end());handles.push_back(state->parent);
  Attributes attributes;
  if(!UpdateProcThreadAttribute(attributes.list,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles.data(),handles.size()*sizeof(HANDLE),nullptr,nullptr))fail();
  auto path=executable();std::wstring command=L"\""+path+L"\"";
  for(HANDLE handle:handles)command+=L" "+std::to_wstring(reinterpret_cast<uintptr_t>(handle));
  STARTUPINFOEXW startup={};startup.StartupInfo.cb=sizeof(startup);startup.lpAttributeList=attributes.list;
  PROCESS_INFORMATION info={};
  if(!CreateProcessW(path.c_str(),command.data(),nullptr,nullptr,TRUE,CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,nullptr,nullptr,&startup.StartupInfo,&info))fail();
  state->process=info.hProcess;CloseHandle(info.hThread);
  for(HANDLE handle:handles)SetHandleInformation(handle,HANDLE_FLAG_INHERIT,0);
  HANDLE waits[]={state->events[0],state->process};
  if(wait(waits,2,10000)!=0){
    // No apply signal was sent. A provider stalled during archive owns no
    // output changes and can be stopped without losing the original clipboard.
    TerminateProcess(state->process,1);fail();
  }
  state->response(ready);
}
Lease::~Lease()=default;
DWORD Lease::apply(){
  if(state->requested)fail();state->requested=true;
  if(!SetEvent(state->events[1]))fail();
  HANDLE waits[]={state->events[2],state->process};
  if(wait(waits,2,5000)!=0){restore();fail();}
  state->response(applied);return state->packet->appliedSequence;
}
bool Lease::active()const{return state&&state->process&&WaitForSingleObject(state->process,0)==WAIT_TIMEOUT;}
void Lease::posted(){if(state)SetEvent(state->events[4]);}
void Lease::restore(){if(state)SetEvent(state->events[3]);}
bool Lease::waitForExit(DWORD milliseconds){return !active()||wait(&state->process,1,milliseconds)==0;}
}
