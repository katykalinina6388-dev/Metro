#!/usr/bin/env python3
"""PNG 256×256 -> значок .ico (PNG внутри ICO). Запуск: python tools/mkico.py icon.png icon.ico"""
import struct
import sys

png = open(sys.argv[1], 'rb').read()
ico = struct.pack('<HHH', 0, 1, 1) + struct.pack('<BBBBHHII', 0, 0, 0, 0, 1, 32, len(png), 22) + png
open(sys.argv[2], 'wb').write(ico)
print('ico', len(ico))
