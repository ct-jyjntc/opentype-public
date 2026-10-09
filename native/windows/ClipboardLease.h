#pragma once
#include <windows.h>
#include <memory>
#include <string>
namespace otclip {
class Lease {
  struct State;
  std::unique_ptr<State> state;
public:
  Lease(const std::wstring& text,const std::string& html);
  ~Lease();
  Lease(const Lease&)=delete;
  DWORD apply();
  bool active()const;
  void posted();
  void restore();
  bool waitForExit(DWORD milliseconds);
};
}
