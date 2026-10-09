#pragma once
#include <windows.h>
#include <sddl.h>
#include <shlobj.h>
#include <aclapi.h>
#include <string>
#include <vector>
#include <stdexcept>
#include <memory>

namespace otprivate {
class Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
public:
  explicit Handle(HANDLE handle = INVALID_HANDLE_VALUE):value(handle){}
  ~Handle(){if(value&&value!=INVALID_HANDLE_VALUE)CloseHandle(value);}
  Handle(const Handle&)=delete;
  Handle& operator=(const Handle&)=delete;
  HANDLE get()const{return value;}
  explicit operator bool()const{return value&&value!=INVALID_HANDLE_VALUE;}
};
class UserAccess {
  std::vector<BYTE> tokenData;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  std::wstring identifier;
public:
  UserAccess(){
    HANDLE raw=nullptr;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&raw))throw std::runtime_error("user_token_unavailable");
    Handle token(raw);DWORD size=0;GetTokenInformation(token.get(),TokenUser,nullptr,0,&size);
    tokenData.resize(size);
    if(!size||!GetTokenInformation(token.get(),TokenUser,tokenData.data(),size,&size))throw std::runtime_error("user_token_unavailable");
    LPWSTR text=nullptr;if(!ConvertSidToStringSidW(user(),&text))throw std::runtime_error("user_sid_unavailable");
    identifier=text;LocalFree(text);
    // No inherited ACEs: this user's recovery state and SYSTEM only.
    auto sddl=L"D:P(A;;FA;;;SY)(A;;FA;;;"+identifier+L")";
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&descriptor,nullptr))throw std::runtime_error("private_acl_unavailable");
  }
  ~UserAccess(){if(descriptor)LocalFree(descriptor);}
  UserAccess(const UserAccess&)=delete;
  PSID user()const{return reinterpret_cast<const TOKEN_USER*>(tokenData.data())->User.Sid;}
  const std::wstring& sid()const{return identifier;}
  SECURITY_ATTRIBUTES attributes()const{return {sizeof(SECURITY_ATTRIBUTES),descriptor,FALSE};}
  bool owned(const std::wstring& path)const{
    PSID owner=nullptr;PSECURITY_DESCRIPTOR security=nullptr;
    auto name=path;
    DWORD status=GetNamedSecurityInfoW(name.data(),SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION,&owner,nullptr,nullptr,nullptr,&security);
    bool same=status==ERROR_SUCCESS&&owner&&EqualSid(owner,user());if(security)LocalFree(security);return same;
  }
};
inline std::wstring directory(const UserAccess& user,const wchar_t* name){
  PWSTR raw=nullptr;if(FAILED(SHGetKnownFolderPath(FOLDERID_RoamingAppData,0,nullptr,&raw)))throw std::runtime_error("app_data_unavailable");
  std::wstring path=raw;CoTaskMemFree(raw);path+=L"\\";path+=name;
  auto access=user.attributes();
  if(!CreateDirectoryW(path.c_str(),&access)&&GetLastError()!=ERROR_ALREADY_EXISTS)throw std::runtime_error("private_directory_unavailable");
  DWORD flags=GetFileAttributesW(path.c_str());
  if(flags==INVALID_FILE_ATTRIBUTES||!(flags&FILE_ATTRIBUTE_DIRECTORY)||(flags&FILE_ATTRIBUTE_REPARSE_POINT)||!user.owned(path))throw std::runtime_error("private_directory_unavailable");
  return path;
}
inline bool plainFile(const std::wstring& path){
  DWORD attributes=GetFileAttributesW(path.c_str());
  if(attributes==INVALID_FILE_ATTRIBUTES)return GetLastError()==ERROR_FILE_NOT_FOUND;
  return !(attributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT));
}
inline std::vector<BYTE> read(const UserAccess& user,const std::wstring& path,size_t maximum,bool& exists){
  exists=false;
  Handle file(CreateFileW(path.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
  if(!file){if(GetLastError()==ERROR_FILE_NOT_FOUND)return {};throw std::runtime_error("private_read_failed");}
  exists=true;BY_HANDLE_FILE_INFORMATION information;LARGE_INTEGER size;
  if(!GetFileInformationByHandle(file.get(),&information)||information.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)
      ||!GetFileSizeEx(file.get(),&size)||size.QuadPart<0||static_cast<ULONGLONG>(size.QuadPart)>maximum||!user.owned(path))throw std::runtime_error("private_read_failed");
  std::vector<BYTE> data(static_cast<size_t>(size.QuadPart));DWORD received=0;
  if(!data.empty()&&(!ReadFile(file.get(),data.data(),static_cast<DWORD>(data.size()),&received,nullptr)||received!=data.size()))throw std::runtime_error("private_read_failed");
  return data;
}
inline bool write(const UserAccess& user,const std::wstring& path,const std::vector<BYTE>& data){
  if(!plainFile(path))return false;
  GUID id;if(FAILED(CoCreateGuid(&id)))return false;wchar_t suffix[40];StringFromGUID2(id,suffix,40);
  std::wstring temporary=path+L"."+suffix+L".tmp";auto access=user.attributes();bool ready=false;
  {
    Handle file(CreateFileW(temporary.c_str(),GENERIC_WRITE,0,&access,CREATE_NEW,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_WRITE_THROUGH|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    if(!file)return false;DWORD written=0;
    ready=WriteFile(file.get(),data.data(),static_cast<DWORD>(data.size()),&written,nullptr)&&written==data.size()&&FlushFileBuffers(file.get());
  }
  if(ready&&MoveFileExW(temporary.c_str(),path.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH))return true;
  DeleteFileW(temporary.c_str());return false;
}
}
