#include "Common.h"
#include <shlwapi.h>
#include <sstream>

namespace ot {
std::wstring wide(const char* text) {
  if (!text || !*text) return {};
  int count = MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text,-1,nullptr,0);
  if (!count) throw std::runtime_error("invalid_utf8");
  std::wstring value(count,L'\0');
  MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text,-1,value.data(),count); value.resize(count-1);
  return value;
}
std::string utf8(const std::wstring& text) {
  if (text.empty()) return {};
  int count = WideCharToMultiByte(CP_UTF8,0,text.data(),static_cast<int>(text.size()),nullptr,0,nullptr,nullptr);
  std::string value(count,'\0');
  WideCharToMultiByte(CP_UTF8,0,text.data(),static_cast<int>(text.size()),value.data(),count,nullptr,nullptr);
  return value;
}
std::string quote(const std::string& text) {
  std::string value = "\""; const char* hex = "0123456789abcdef";
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') { value += '\\'; value += c; }
    else if (c < 32) { value += "\\u00"; value += hex[c>>4]; value += hex[c&15]; }
    else value += c;
  }
  return value + '"';
}
char* result(const std::string& text) { return _strdup(text.c_str()); }
std::string object(std::initializer_list<std::pair<std::string,std::string>> fields) {
  std::string out = "{";
  for (const auto& field : fields) { if (out.size()>1) out+=','; out+=quote(field.first)+':'+field.second; }
  return out+'}';
}
std::string failure(const char* reason) { return object({{"reason",quote(std::string(reason))}}); }
std::string guid() { GUID id; if (FAILED(CoCreateGuid(&id))) throw std::runtime_error("uuid_failed"); wchar_t buffer[40]; StringFromGUID2(id,buffer,40); return utf8(buffer); }
int64_t epochMilliseconds() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
std::wstring processName(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid); if (!process) return {};
  std::wstring path(32768,L'\0'); DWORD size = static_cast<DWORD>(path.size());
  BOOL ok = QueryFullProcessImageNameW(process,0,path.data(),&size); CloseHandle(process);
  if (!ok) return {}; path.resize(size);
  return PathFindFileNameW(path.c_str());
}
std::string appFields(HWND window) {
  DWORD pid = 0; GetWindowThreadProcessId(window,&pid); auto name = processName(pid);
  std::wstring identifier = name; std::transform(identifier.begin(),identifier.end(),identifier.begin(),towlower);
  return "\"appName\":"+quote(name)+",\"bundleId\":"+quote(identifier)+",\"pid\":"+std::to_string(pid);
}
std::string appInfo(HWND window) { return "{"+appFields(window)+"}"; }
static DWORD integrity(HANDLE process) {
  HANDLE token = nullptr; if (!OpenProcessToken(process,TOKEN_QUERY,&token)) return MAXDWORD;
  DWORD size = 0; GetTokenInformation(token,TokenIntegrityLevel,nullptr,0,&size);
  std::vector<BYTE> data(size); DWORD level = MAXDWORD;
  if (size && GetTokenInformation(token,TokenIntegrityLevel,data.data(),size,&size)) {
    PSID sid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(data.data())->Label.Sid;
    level = *GetSidSubAuthority(sid,*GetSidSubAuthorityCount(sid)-1);
  }
  CloseHandle(token); return level;
}
bool sameIntegrity(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid); if (!process) return false;
  DWORD target = integrity(process), ours = integrity(GetCurrentProcess()); CloseHandle(process);
  return target != MAXDWORD && ours != MAXDWORD && target <= ours;
}
bool inputDesktopAvailable() {
  HDESK desktop = OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS); if (!desktop) return false;
  wchar_t name[256]; DWORD size = 0;
  bool usable = GetUserObjectInformationW(desktop,UOI_NAME,name,sizeof(name),&size) && _wcsicmp(name,L"Default") == 0;
  CloseDesktop(desktop); return usable;
}

class SystemThread {
  HANDLE wake = CreateEventW(nullptr,FALSE,FALSE,nullptr);
  std::mutex mutex;
  std::deque<std::function<void()>> tasks;
  std::thread thread;
  std::atomic<DWORD> id{0};
public:
  SystemThread() {
    if (!wake) throw std::runtime_error("system_worker_failed");
    thread = std::thread([this] {
      HRESULT initialized = OleInitialize(nullptr);
      id = GetCurrentThreadId();
      for (;;) {
        DWORD ready = MsgWaitForMultipleObjectsEx(1,&wake,INFINITE,QS_ALLINPUT,MWMO_INPUTAVAILABLE);
        if (ready == WAIT_OBJECT_0) {
          std::deque<std::function<void()>> batch;
          { std::lock_guard<std::mutex> guard(mutex); batch.swap(tasks); }
          for (auto& task : batch) task();
        }
        MSG msg; while (PeekMessageW(&msg,nullptr,0,0,PM_REMOVE)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
        if (ready == WAIT_FAILED) break;
      }
      if (SUCCEEDED(initialized)) OleUninitialize();
    });
    thread.detach(); // Process-scoped; no thread joins from DllMain/loader lock.
  }
  void post(std::function<void()> task) {
    if (id == GetCurrentThreadId()) { task(); return; }
    { std::lock_guard<std::mutex> guard(mutex); tasks.push_back(std::move(task)); }
    SetEvent(wake);
  }
};
void onSystemThread(std::function<void()> action) { static auto* thread = new SystemThread; thread->post(std::move(action)); }
IUIAutomation* automation() {
  // Only called by the system worker.
  static ComPtr<IUIAutomation> client;
  if (!client) {
    if (FAILED(CoCreateInstance(CLSID_CUIAutomation8,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&client)))) return nullptr;
    ComPtr<IUIAutomation2> options;
    if (SUCCEEDED(client.As(&options))) { options->put_ConnectionTimeout(1000); options->put_TransactionTimeout(1000); }
  }
  return client.Get();
}
}
OT_EXPORT void freeString(void* text) { free(text); }
