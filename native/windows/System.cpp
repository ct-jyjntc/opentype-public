#include "Common.h"
#include <mmdeviceapi.h>
#include <endpointvolume.h>
#include <audioclient.h>
#include <initguid.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propsys.h>
#include <bcrypt.h>
#include <shellapi.h>

namespace {
ComPtr<IMMDeviceEnumerator> enumerator(){ComPtr<IMMDeviceEnumerator> value;CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_ALL,IID_PPV_ARGS(&value));return value;}
ComPtr<IAudioEndpointVolume> microphone(){auto devices=enumerator();ComPtr<IMMDevice> device;ComPtr<IAudioEndpointVolume> volume;
  if(devices&&SUCCEEDED(devices->GetDefaultAudioEndpoint(eCapture,eConsole,&device)))device->Activate(__uuidof(IAudioEndpointVolume),CLSCTX_ALL,nullptr,&volume);return volume;}
std::wstring registryString(HKEY hive,const wchar_t* key,const wchar_t* name){
  DWORD size=0;if(RegGetValueW(hive,key,name,RRF_RT_REG_SZ|RRF_SUBKEY_WOW6464KEY,nullptr,nullptr,&size)!=ERROR_SUCCESS||size>65536)return {};
  std::wstring value(size/sizeof(wchar_t),L'\0');if(RegGetValueW(hive,key,name,RRF_RT_REG_SZ|RRF_SUBKEY_WOW6464KEY,nullptr,value.data(),&size)!=ERROR_SUCCESS)return {};
  value.resize(wcsnlen(value.c_str(),value.size()));return value;
}
std::string deviceID(){
  auto guid=registryString(HKEY_LOCAL_MACHINE,L"SOFTWARE\\Microsoft\\Cryptography",L"MachineGuid");if(guid.empty())return "unknown";
  std::string material="OpenType/device/"+ot::utf8(guid);BYTE digest[32];
  if(BCryptHash(BCRYPT_SHA256_ALG_HANDLE,nullptr,0,reinterpret_cast<PUCHAR>(material.data()),static_cast<ULONG>(material.size()),digest,sizeof(digest))<0)return "unknown";
  std::string out;const char* hex="0123456789abcdef";for(BYTE b:digest){out+=hex[b>>4];out+=hex[b&15];}return out;
}
}
OT_EXPORT int checkAccessibilityPermission(){return ot::inputDesktopAvailable()?1:0;}
OT_EXPORT int checkMicrophonePermission(){
  auto preference=registryString(HKEY_CURRENT_USER,L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone",L"Value");
  if(preference==L"Deny")return 2;if(preference==L"Allow")return 3;return 0;
}
OT_EXPORT char* getAudioDevicesJSON(){try{return ot::result(ot::system([]{
  auto devices=enumerator();ComPtr<IMMDeviceCollection> inputs;ComPtr<IMMDevice> primary;LPWSTR defaultID=nullptr;
  if(!devices||FAILED(devices->EnumAudioEndpoints(eCapture,DEVICE_STATE_ACTIVE,&inputs)))return std::string("[]");
  if(SUCCEEDED(devices->GetDefaultAudioEndpoint(eCapture,eConsole,&primary)))primary->GetId(&defaultID);
  std::wstring defaultName=defaultID?defaultID:L"";CoTaskMemFree(defaultID);UINT count=0;inputs->GetCount(&count);std::string out="[";
  for(UINT i=0;i<count;i++){
    ComPtr<IMMDevice> device;if(FAILED(inputs->Item(i,&device)))continue;
    LPWSTR raw=nullptr;if(FAILED(device->GetId(&raw)))continue;std::wstring id=raw;CoTaskMemFree(raw);
    ComPtr<IPropertyStore> properties;PROPVARIANT label;PropVariantInit(&label);std::wstring name=id;
    if(SUCCEEDED(device->OpenPropertyStore(STGM_READ,&properties))&&SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName,&label))&&label.vt==VT_LPWSTR)name=label.pwszVal;
    PropVariantClear(&label);int channels=0;ComPtr<IAudioClient> audio;WAVEFORMATEX* format=nullptr;
    if(SUCCEEDED(device->Activate(__uuidof(IAudioClient),CLSCTX_ALL,nullptr,&audio))&&SUCCEEDED(audio->GetMixFormat(&format))){channels=format->nChannels;CoTaskMemFree(format);}
    if(out.size()>1)out+=',';out+=ot::object({{"deviceId",ot::quote(id)},{"label",ot::quote(name)},{"groupId","\"\""},{"channels",std::to_string(channels)},
      {"index",std::to_string(i)},{"isDefault",id==defaultName?"true":"false"}});
  }return out+']';
}));}catch(...){return ot::result("[]");}}
OT_EXPORT int isAudioMuted(){try{return ot::system([]{auto volume=microphone();BOOL muted=FALSE;return volume&&SUCCEEDED(volume->GetMute(&muted))&&muted?1:0;});}catch(...){return 0;}}
OT_EXPORT int muteAudio(){try{return ot::system([]{auto volume=microphone();return volume&&SUCCEEDED(volume->SetMute(TRUE,nullptr))?0:-1;});}catch(...){return -1;}}
OT_EXPORT int unmuteAudio(){try{return ot::system([]{auto volume=microphone();return volume&&SUCCEEDED(volume->SetMute(FALSE,nullptr))?0:-1;});}catch(...){return -1;}}
// Windows powerMonitor cancels capture on suspend/lock. There is no portable
// synchronous lid sensor; do not block recording on desktops without a lid.
OT_EXPORT int deviceIsLidOpen(){return 1;}
OT_EXPORT char* getDeviceId(){try{return ot::result(deviceID());}catch(...){return ot::result("unknown");}}
OT_EXPORT bool launchApplicationByName(const char* name){try{
  auto executable=ot::wide(name);if(executable.size()<5||executable.find_first_of(L"\"\r\n")!=std::wstring::npos||executable.find(L"://")!=std::wstring::npos)return false;
  auto extension=executable.substr(executable.size()-4);std::transform(extension.begin(),extension.end(),extension.begin(),towlower);if(extension!=L".exe")return false;
  return reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr,L"open",executable.c_str(),nullptr,nullptr,SW_SHOWNORMAL))>32;
}catch(...){return false;}}
