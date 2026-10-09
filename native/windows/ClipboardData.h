#pragma once
#include <windows.h>
#include <ole2.h>
#include <shlobj.h>
#include <wrl/client.h>
#include <atomic>
#include <string>
#include <vector>
#include <cstring>
#include <cstdio>
#include <stdexcept>
#include <cstdint>
namespace otclip {
using Microsoft::WRL::ComPtr;
constexpr uint64_t clipboardLimit=256ull*1024*1024;
uint64_t mediumSize(const STGMEDIUM& source){
  switch(source.tymed){
    case TYMED_HGLOBAL:return GlobalSize(source.hGlobal);
    case TYMED_GDI:{
      BITMAP bitmap={};if(GetObjectW(source.hBitmap,sizeof(bitmap),&bitmap)!=sizeof(bitmap)||bitmap.bmWidthBytes<0)return clipboardLimit+1;
      int64_t height=bitmap.bmHeight;return static_cast<uint64_t>(bitmap.bmWidthBytes)*static_cast<uint64_t>(height<0?-height:height);
    }
    case TYMED_MFPICT:{
      auto* picture=static_cast<METAFILEPICT*>(GlobalLock(source.hMetaFilePict));if(!picture)return clipboardLimit+1;
      UINT size=GetMetaFileBitsEx(picture->hMF,0,nullptr);GlobalUnlock(source.hMetaFilePict);return size?static_cast<uint64_t>(size)+sizeof(METAFILEPICT):clipboardLimit+1;
    }
    case TYMED_ENHMF:{UINT size=GetEnhMetaFileBits(source.hEnhMetaFile,0,nullptr);return size?size:clipboardLimit+1;}
    default:return clipboardLimit+1;
  }
}
// Fully materialize clipboard formats before replacing ownership. If a format
// cannot be preserved, refuse the paste instead of dropping the user's data.
bool copyMedium(const FORMATETC& format,const STGMEDIUM& source,STGMEDIUM& out) {
  ZeroMemory(&out,sizeof(out));out.tymed=source.tymed;
  if(mediumSize(source)>clipboardLimit)return false;
  switch(source.tymed){
    case TYMED_HGLOBAL:
      out.hGlobal=static_cast<HGLOBAL>(OleDuplicateData(source.hGlobal,format.cfFormat,0));return out.hGlobal!=nullptr;
    case TYMED_GDI:out.hBitmap=static_cast<HBITMAP>(OleDuplicateData(source.hBitmap,format.cfFormat,0));return out.hBitmap!=nullptr;
    case TYMED_MFPICT:out.hMetaFilePict=static_cast<HMETAFILEPICT>(OleDuplicateData(source.hMetaFilePict,format.cfFormat,0));return out.hMetaFilePict!=nullptr;
    case TYMED_ENHMF:out.hEnhMetaFile=static_cast<HENHMETAFILE>(OleDuplicateData(source.hEnhMetaFile,format.cfFormat,0));return out.hEnhMetaFile!=nullptr;
    default:out.tymed=TYMED_NULL;return false;
  }
}
class ClipboardData final:public IDataObject {
  std::atomic<ULONG> references{1};
public:
  struct Item{FORMATETC format;STGMEDIUM medium;};std::vector<Item> items;
  ~ClipboardData(){for(auto& item:items)ReleaseStgMedium(&item.medium);}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id,void** value)override{
    if(!value)return E_POINTER;*value=nullptr;if(id==IID_IUnknown||id==IID_IDataObject){*value=static_cast<IDataObject*>(this);AddRef();return S_OK;}return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef()override{return ++references;}
  ULONG STDMETHODCALLTYPE Release()override{ULONG left=--references;if(!left)delete this;return left;}
  HRESULT STDMETHODCALLTYPE GetData(FORMATETC* format,STGMEDIUM* medium)override{
    if(!format||!medium)return E_POINTER;
    for(const auto& item:items)if(format->cfFormat==item.format.cfFormat&&format->dwAspect==item.format.dwAspect&&format->lindex==item.format.lindex&&(format->tymed&item.medium.tymed))
      return copyMedium(item.format,item.medium,*medium)?S_OK:DV_E_TYMED;
    return DV_E_FORMATETC;
  }
  HRESULT STDMETHODCALLTYPE QueryGetData(FORMATETC* format)override{
    if(!format)return E_POINTER;for(const auto& item:items)if(format->cfFormat==item.format.cfFormat&&format->dwAspect==item.format.dwAspect&&format->lindex==item.format.lindex&&(format->tymed&item.medium.tymed))return S_OK;return DV_E_FORMATETC;
  }
  HRESULT STDMETHODCALLTYPE GetDataHere(FORMATETC*,STGMEDIUM*)override{return DATA_E_FORMATETC;}
  HRESULT STDMETHODCALLTYPE GetCanonicalFormatEtc(FORMATETC*,FORMATETC* out)override{if(!out)return E_POINTER;out->ptd=nullptr;return E_NOTIMPL;}
  HRESULT STDMETHODCALLTYPE SetData(FORMATETC*,STGMEDIUM*,BOOL)override{return E_NOTIMPL;}
  HRESULT STDMETHODCALLTYPE EnumFormatEtc(DWORD direction,IEnumFORMATETC** output)override{
    if(direction!=DATADIR_GET)return E_NOTIMPL;std::vector<FORMATETC> formats;for(const auto& item:items)formats.push_back(item.format);
    return SHCreateStdEnumFmtEtc(static_cast<UINT>(formats.size()),formats.data(),output);
  }
  HRESULT STDMETHODCALLTYPE DAdvise(FORMATETC*,DWORD,IAdviseSink*,DWORD*)override{return OLE_E_ADVISENOTSUPPORTED;}
  HRESULT STDMETHODCALLTYPE DUnadvise(DWORD)override{return OLE_E_ADVISENOTSUPPORTED;}
  HRESULT STDMETHODCALLTYPE EnumDAdvise(IEnumSTATDATA**)override{return OLE_E_ADVISENOTSUPPORTED;}
  void add(CLIPFORMAT format,const void* data,size_t size){
    HGLOBAL memory=GlobalAlloc(GMEM_MOVEABLE,size);if(!memory)throw std::runtime_error("injection_clipboard_unavailable");
    void* destination=GlobalLock(memory);if(!destination){GlobalFree(memory);throw std::runtime_error("injection_clipboard_unavailable");}
    memcpy(destination,data,size);GlobalUnlock(memory);
    FORMATETC type={format,nullptr,DVASPECT_CONTENT,-1,TYMED_HGLOBAL};STGMEDIUM medium={};medium.tymed=TYMED_HGLOBAL;medium.hGlobal=memory;
    try{items.push_back({type,medium});}catch(...){GlobalFree(memory);throw;}
  }
};
ComPtr<ClipboardData> archiveClipboard(){
  ComPtr<IDataObject> current;HRESULT available=OleGetClipboard(&current);
  ComPtr<ClipboardData> saved;saved.Attach(new ClipboardData);
  if(FAILED(available)){
    // A truly empty clipboard has no object to save; access failure is not empty.
    if(OpenClipboard(nullptr)){
      SetLastError(ERROR_SUCCESS);UINT first=EnumClipboardFormats(0);DWORD error=GetLastError();CloseClipboard();
      if(!first&&error==ERROR_SUCCESS)return saved;
    }
    throw std::runtime_error("injection_clipboard_unavailable");
  }
  ComPtr<IEnumFORMATETC> formats;if(!current||FAILED(current->EnumFormatEtc(DATADIR_GET,&formats)))throw std::runtime_error("injection_clipboard_unavailable");
  FORMATETC format;ULONG count=0;size_t total=0;
  HRESULT next=S_OK;
  while((next=formats->Next(1,&format,&count))==S_OK){
    if(format.ptd){CoTaskMemFree(format.ptd);throw std::runtime_error("injection_clipboard_unavailable");}
    if(saved->items.size()>=128)throw std::runtime_error("injection_clipboard_unavailable");
    STGMEDIUM source={},copy={};if(FAILED(current->GetData(&format,&source)))throw std::runtime_error("injection_clipboard_unavailable");
    total+=mediumSize(source);
    bool copied=total<=clipboardLimit&&copyMedium(format,source,copy);ReleaseStgMedium(&source);
    if(!copied)throw std::runtime_error("injection_clipboard_unavailable");
    format.tymed=copy.tymed;
    try{saved->items.push_back({format,copy});}catch(...){ReleaseStgMedium(&copy);throw;}
  }
  if(next!=S_FALSE)throw std::runtime_error("injection_clipboard_unavailable");
  return saved;
}
std::string htmlClipboard(const std::string& html){
  std::string prefix="<html><body><!--StartFragment-->",suffix="<!--EndFragment--></body></html>";
  const char* format="Version:1.0\r\nStartHTML:%010u\r\nEndHTML:%010u\r\nStartFragment:%010u\r\nEndFragment:%010u\r\n";
  char header[256];int size=snprintf(header,sizeof(header),format,0u,0u,0u,0u);
  snprintf(header,sizeof(header),format,static_cast<unsigned>(size),static_cast<unsigned>(size+prefix.size()+html.size()+suffix.size()),
    static_cast<unsigned>(size+prefix.size()),static_cast<unsigned>(size+prefix.size()+html.size()));
  return std::string(header)+prefix+html+suffix;
}

}
