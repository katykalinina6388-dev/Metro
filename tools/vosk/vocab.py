#!/usr/bin/env python3
"""Каких слов из грамматики команд нет в словаре модели Vosk. Запуск: python tools/vosk/vocab.py <модель> <grammar.json>"""
import json
import sys

words = set()
for line in open(sys.argv[1] + '/graph/words.txt', encoding='utf-8'):
    words.add(line.split(' ')[0])
gram = json.load(open(sys.argv[2], encoding='utf-8'))
need = set()
for s in gram:
    for w in s.split():
        need.add(w)
missing = sorted(w for w in need if w not in words)
print('grammar words', len(need), 'missing', missing)
for stem in sys.argv[3:]:
    print(stem, '->', sorted(w for w in words if w.startswith(stem))[:14])
