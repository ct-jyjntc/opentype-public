cmake_minimum_required(VERSION 3.20)
project(OpenTypeNative LANGUAGES CXX)
if(NOT WIN32)
  message(FATAL_ERROR "Build this helper on Windows with the Windows SDK")
endif()
add_library(OpenTypeNative SHARED Common.cpp Keyboard.cpp Input.cpp ClipboardLease.cpp System.cpp)
target_compile_features(OpenTypeNative PRIVATE cxx_std_17)
target_compile_definitions(OpenTypeNative PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
target_link_libraries(OpenTypeNative PRIVATE ole32 oleaut32 user32 advapi32 shell32 shlwapi uuid propsys uiautomationcore bcrypt)
if(MSVC)
  target_compile_options(OpenTypeNative PRIVATE /W4 /EHsc /utf-8)
endif()
set_target_properties(OpenTypeNative PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/build"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_SOURCE_DIR}/build"
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(OutputAudio OutputAudio.cpp)
target_compile_features(OutputAudio PRIVATE cxx_std_17)
target_compile_definitions(OutputAudio PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
target_link_libraries(OutputAudio PRIVATE ole32 user32 advapi32 shell32 uuid)
set_target_properties(OutputAudio PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/build"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_SOURCE_DIR}/build"
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
if(MSVC)
  target_compile_options(OutputAudio PRIVATE /W4 /EHsc /utf-8)
endif()

add_executable(ClipboardGuard ClipboardGuard.cpp)
target_compile_features(ClipboardGuard PRIVATE cxx_std_17)
target_compile_definitions(ClipboardGuard PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
target_link_libraries(ClipboardGuard PRIVATE ole32 oleaut32 user32 gdi32 advapi32 shell32 uuid)
set_target_properties(ClipboardGuard PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/build"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_SOURCE_DIR}/build"
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
if(MSVC)
  target_compile_options(ClipboardGuard PRIVATE /W4 /EHsc /utf-8)
endif()
