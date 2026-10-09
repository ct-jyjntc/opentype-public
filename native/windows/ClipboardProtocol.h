#pragma once
#include <windows.h>
#include <objbase.h>
#include <cstdint>
namespace otclip {
constexpr uint32_t magic = 0x4f54434c;
constexpr uint32_t maximumPayload = 16*1024*1024;
enum Result : LONG { waiting=0, ready=1, applied=2, unavailable=3, changed=4, occupied=5 };
struct Packet {
  uint32_t signature=magic,version=1,textBytes=0,htmlBytes=0,originalSequence=0;
  volatile LONG result=waiting;
  DWORD appliedSequence=0;
};
// Calls originate on the parent DLL's COM STA. Dispatch COM/window messages
// while waiting, so archiving an OLE object owned by that STA can complete.
inline DWORD wait(HANDLE* handles,ULONG count,DWORD timeout){
  DWORD index=0;
  HRESULT result=CoWaitForMultipleHandles(COWAIT_DISPATCH_CALLS|COWAIT_DISPATCH_WINDOW_MESSAGES,timeout,count,handles,&index);
  return SUCCEEDED(result)?index:result==RPC_S_CALLPENDING?WAIT_TIMEOUT:WAIT_FAILED;
}
}
