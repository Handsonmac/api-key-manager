#!/usr/bin/env python3
"""
把若干 PNG 组装成 Windows 多尺寸 .ico（条目用 PNG 编码，Vista+ 原生支持）。
零第三方依赖：PNG 尺寸直接从 IHDR 读取。
用法：python3 build/make-ico.py <out.ico> <a.png> <b.png> ...
"""
import struct
import sys


def png_size(data: bytes):
    if data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
        raise ValueError('不是合法 PNG')
    w, h = struct.unpack('>II', data[16:24])
    return w, h


def build_ico(pngs):
    entries = []
    for p in pngs:
        with open(p, 'rb') as f:
            data = f.read()
        w, h = png_size(data)
        if w != h:
            raise ValueError(f'{p}: 宽高不一致 {w}x{h}')
        entries.append((w, data))

    count = len(entries)
    header = struct.pack('<HHH', 0, 1, count)
    offset = 6 + 16 * count
    directory = b''
    body = b''
    for w, data in entries:
        b = 0 if w >= 256 else w  # 0 表示 256
        directory += struct.pack('<BBBBHHII', b, b, 0, 0, 1, 32, len(data), offset)
        body += data
        offset += len(data)
    return header + directory + body


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    out, pngs = sys.argv[1], sys.argv[2:]
    with open(out, 'wb') as f:
        f.write(build_ico(pngs))
    print(f'✓ {out} 生成完毕（{len(pngs)} 个尺寸: {[png_size(open(p, "rb").read())[0] for p in pngs]}）')
