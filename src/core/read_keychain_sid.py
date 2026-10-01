#!/usr/bin/env python3
"""读取 Windows 凭据管理器中 wps365-cli 保存的 wps_sid（与 kdocs-cli 引擎同一会话）。
用法: python read_keychain_sid.py [target_name]
默认 target: wps365-cli:credential_wps_sid
输出: sid 值（纯文本，无换行）；失败输出空。
"""
import ctypes
import sys

target = sys.argv[1] if len(sys.argv) > 1 else "wps365-cli:credential_wps_sid"


class CREDENTIAL(ctypes.Structure):
    _fields_ = [
        ("Flags", ctypes.c_ulong),
        ("Type", ctypes.c_ulong),
        ("TargetName", ctypes.c_wchar_p),
        ("Comment", ctypes.c_wchar_p),
        ("LastWritten", ctypes.c_longlong),
        ("CredentialBlobSize", ctypes.c_ulong),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_byte)),
        ("Persist", ctypes.c_ulong),
        ("AttributeCount", ctypes.c_ulong),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", ctypes.c_wchar_p),
        ("UserName", ctypes.c_wchar_p),
    ]


def main():
    p = ctypes.POINTER(CREDENTIAL)()
    ok = ctypes.windll.advapi32.CredReadW(target, 1, 0, ctypes.byref(p))
    if not ok:
        return
    try:
        blob = ctypes.string_at(p.contents.CredentialBlob, p.contents.CredentialBlobSize)
        try:
            sys.stdout.write(blob.decode("utf-8"))
        except Exception:
            sys.stdout.write(blob.decode("latin-1"))
    finally:
        ctypes.windll.advapi32.CredFree(p)


if __name__ == "__main__":
    main()
