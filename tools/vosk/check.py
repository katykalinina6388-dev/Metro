#!/usr/bin/env python3
"""Проверка распознавания команд: синтезирует фразы Piper и распознаёт их Vosk с грамматикой игры.

Запуск: python tools/vosk/check.py <каталог модели> <grammar.json> [каталог голосов piper]
"""
import json
import os
import sys
import wave

import numpy as np
from piper import PiperVoice, SynthesisConfig
from vosk import KaldiRecognizer, Model, SetLogLevel

MODEL = sys.argv[1]
GRAMMAR = json.load(open(sys.argv[2], encoding='utf-8'))
VDIR = sys.argv[3] if len(sys.argv) > 3 else '/tmp/dl/piper'
OUTWAV = sys.argv[4] if len(sys.argv) > 4 else '/tmp/dl/cmdwav'
PHRASES = [
    'маршрут двенадцать, следуйте в депо',
    'маршрут пять, отправляйтесь',
    'двадцать первый, следуйте до станции Ломоносовская',
    'маршрут семь, оборот по станции Площадь Александра Невского',
    'маршрут три, скорость не более сорока',
    'маршрут восемнадцать, проследуйте запрещающий сигнал',
    'маршрут девять, высадите пассажиров',
    'маршрут тридцать, выходите на линию',
    'маршрут четырнадцать, стоп',
    'маршрут два, доложите обстановку',
    'маршрут шесть, станцию Гостиный двор проследуйте без остановки',
    'маршрут одиннадцать, следуйте в тупик станции Маяковская',
    'всем поездам стоп',
    'маршрут четыре, следуйте до станции Елизаровская',
    'маршрут десять, станцию Василеостровская проследуйте без остановки',
    'двадцать четвёртый, задержитесь на станции Маяковская',
]

SetLogLevel(-1)
model = Model(MODEL)
os.makedirs(OUTWAV, exist_ok=True)
ok = 0
for vi, vname in enumerate(['irina', 'denis']):
    voice = PiperVoice.load(os.path.join(VDIR, 'ru_RU-%s-medium.onnx' % vname))
    for pi, text in enumerate(PHRASES):
        path = os.path.join(OUTWAV, '%s_%02d.wav' % (vname, pi))
        with wave.open(path, 'wb') as w:
            voice.synthesize_wav(text, w, syn_config=SynthesisConfig(length_scale=1.0))
        with wave.open(path, 'rb') as w:
            sr = w.getframerate(); x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        # пересчёт в 16 кГц с паузами по краям — как с микрофона
        n = int(len(x) * 16000 / sr)
        y = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x.astype(np.float32)).astype(np.int16)
        y = np.concatenate([np.zeros(8000, np.int16), y, np.zeros(12000, np.int16)])
        with wave.open(path, 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(y.tobytes())
        rec = KaldiRecognizer(model, 16000, json.dumps(GRAMMAR, ensure_ascii=False))
        rec.AcceptWaveform(y.tobytes())
        res = json.loads(rec.FinalResult())['text'].replace('[unk]', '').strip()
        norm = ' '.join(text.lower().replace(',', '').split())
        good = res == norm
        ok += good
        print('OK ' if good else 'DIFF', vname, '|', norm, '=>', res)
print('exact', ok, 'of', len(PHRASES) * 2)
