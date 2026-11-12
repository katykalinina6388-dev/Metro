#!/usr/bin/env python3
"""Упаковка модели распознавания речи Vosk (vosk-model-small-ru) для игры.

Игра распознаёт только команды диспетчера (ограниченный словарь), поэтому большая языковая
модель Gr.fst не нужна: из неё берётся таблица слов (graph/words.txt), а сам файл заменяется
пустым автоматом. Архив получается почти вдвое меньше.

Запуск:  python tools/vosk/pack.py <распакованная vosk-model-small-ru-0.22> <выходной каталог модели> [архив.tar.gz]
"""
import os
import shutil
import struct
import sys
import tarfile

SRC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/dl/vosk-model-small-ru-0.22'
DST = sys.argv[2] if len(sys.argv) > 2 else '/tmp/dl/model-ru'
TAR = sys.argv[3] if len(sys.argv) > 3 else None


def read_symbols(path):
    f = open(path, 'rb')

    def rs():
        n = struct.unpack('<i', f.read(4))[0]
        return f.read(n).decode('utf-8')
    magic = struct.unpack('<i', f.read(4))[0]
    assert magic == 2125659606, 'не файл OpenFst'
    rs(); rs()
    _ver, flags = struct.unpack('<ii', f.read(8))
    f.read(8 + 24)
    assert flags & 2, 'в Gr.fst нет таблицы выходных символов'
    tables = []
    for _ in range(2 if flags & 1 else 1):
        m2 = struct.unpack('<i', f.read(4))[0]
        assert m2 == 2125658996
        rs()
        _avail, size = struct.unpack('<qq', f.read(16))
        syms = []
        for _i in range(size):
            s = rs(); k, = struct.unpack('<q', f.read(8))
            syms.append((s, k))
        tables.append(syms)
    return tables[-1]


def tiny_fst(path):
    """Одно конечное состояние без дуг, формат OpenFst «vector»."""
    def ws(s):
        b = s.encode(); return struct.pack('<i', len(b)) + b
    data = struct.pack('<i', 2125659606) + ws('vector') + ws('standard') + struct.pack('<ii', 2, 0)
    data += struct.pack('<Q', 0x3) + struct.pack('<qqq', 0, 1, 0)
    data += struct.pack('<f', 0.0) + struct.pack('<q', 0)
    open(path, 'wb').write(data)


def main():
    if os.path.exists(DST):
        shutil.rmtree(DST)
    for d in ('am', 'conf', 'ivector'):
        shutil.copytree(os.path.join(SRC, d), os.path.join(DST, d))
    os.makedirs(os.path.join(DST, 'graph', 'phones'))
    for f in ('HCLr.fst', 'disambig_tid.int', 'phones/word_boundary.int'):
        shutil.copy(os.path.join(SRC, 'graph', f), os.path.join(DST, 'graph', f))
    syms = read_symbols(os.path.join(SRC, 'graph', 'Gr.fst'))
    with open(os.path.join(DST, 'graph', 'words.txt'), 'w', encoding='utf-8') as f:
        for s, k in sorted(syms, key=lambda x: x[1]):
            f.write('%s %d\n' % (s, k))
    tiny_fst(os.path.join(DST, 'graph', 'Gr.fst'))
    print('words', len(syms))
    if TAR:
        os.makedirs(os.path.dirname(TAR), exist_ok=True)
        with tarfile.open(TAR, 'w:gz', compresslevel=9) as t:
            t.add(DST, arcname='model')
        print('archive', TAR, os.path.getsize(TAR))


if __name__ == '__main__':
    main()
