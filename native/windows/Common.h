#pragma once
#include <windows.h>
#include <objbase.h>
#include <ole2.h>
#include <uiautomation.h>
#include <wrl/client.h>
#include <string>
#include <vector>
#include <map>
#include <deque>
#include <mutex>
#include <thread>
#include <future>
#include <functional>
#include <atomic>
#include <algorithm>
#include <chrono>
#include <memory>
#include <stdexcept>
#include <cwctype>
#include <cstring>

#define OT_EXPORT extern "C" __declspec(dllexport)
using Microsoft::WRL::ComPtr;
namespace ot {
std::wstring wide(const char* text);
std::string utf8(const std::wstring& text);
std::string quote(const std::string& text);
inline std::string quote(const std::wstring& text) { return quote(utf8(text)); }
char* result(const std::string& text);
std::string object(std::initializer_list<std::pair<std::string,std::string>> fields);
std::string failure(const char* reason);
std::string guid();
int64_t epochMilliseconds();
std::wstring processName(DWORD pid);
std::string appInfo(HWND window);
std::string appFields(HWND window);
bool sameIntegrity(DWORD pid);
bool inputDesktopAvailable();
constexpr ULONG_PTR inputMarker = 0x4f545950;

// UI Automation objects and clipboard ownership stay in a single STA with a
// pumping message loop. Koffi async and sync calls never share COM pointers.
void onSystemThread(std::function<void()> action);
template<class F> auto system(F action) -> decltype(action()) {
  using R = decltype(action());
  auto task = std::make_shared<std::packaged_task<R()>>(std::move(action));
  auto future = task->get_future();
  onSystemThread([task] { (*task)(); });
  return future.get();
}
IUIAutomation* automation();
}
