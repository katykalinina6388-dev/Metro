#!/usr/bin/env python3
"""Упаковка архива для Windows. Имена файлов пишутся в UTF-8 с флагом, который понимает Проводник;
текстовые файлы — с окончаниями строк CRLF и меткой BOM, чтобы их правильно открывал Блокнот.
Запуск: python tools/mkzip.py <каталог> <архив.zip>"""
import os
import sys
import zipfile

src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name in sorted(os.listdir(src)):
        data = open(os.path.join(src, name), 'rb').read()
        if name.lower().endswith('.txt'):
            text = data.decode('utf-8').replace('\r\n', '\n').replace('\n', '\r\n')
            data = b'\xef\xbb\xbf' + text.encode('utf-8')
        info = zipfile.ZipInfo(name)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        info.date_time = __import__('time').localtime()[:6]
        z.writestr(info, data, compresslevel=9)
with zipfile.ZipFile(out) as z:
    for i in z.infolist():
        print('%10d  utf8=%s  %s' % (i.file_size, bool(i.flag_bits & 0x800), i.filename))
print('archive', out, os.path.getsize(out))
