#!/usr/bin/env python3
"""Генерация озвучки машинистов и дежурных по станции (Piper TTS) и упаковка в game/voices/.

Запуск:  python tools/voice/gen.py <каталог с голосами piper *.onnx> [каталог кэша]
Нужны: piper-tts, numpy, ffmpeg, node. Результат: game/voices/{d0,d1,d2,st}.bin и index.json.
Каждый фрагмент — Ogg/Opus; index.json хранит смещение и длину фрагмента в файле голоса.
"""
import hashlib
import json
import os
import subprocess
import sys
import wave

import numpy as np
from piper import PiperVoice, SynthesisConfig

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VOICE_DIR = sys.argv[1] if len(sys.argv) > 1 else '/tmp/dl/piper'
CACHE = sys.argv[2] if len(sys.argv) > 2 else '/tmp/dl/voicecache'
OUT = os.path.join(ROOT, 'game', 'voices')
# условное имя в игре -> (голос piper, темп речи, сдвиг высоты тона).
# Используются только голоса denis и dmitri (наборы данных под CC0); третий машинист и дежурный
# по станции получены из них сдвигом высоты тона.
VOICES = {'d0': ('denis', 0.90, 1.0), 'd1': ('dmitri', 0.92, 1.0), 'd2': ('denis', 0.96, 0.90), 'st': ('dmitri', 0.90, 1.09)}


def synth(voice, cfg, text, path_wav):
    with wave.open(path_wav, 'wb') as w:
        voice.synthesize_wav(text, w, syn_config=cfg)
    with wave.open(path_wav, 'rb') as w:
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    # обрезка тишины по краям и выравнивание громкости
    peak = float(np.max(np.abs(x))) if len(x) else 0.0
    if peak > 0:
        idx = np.nonzero(np.abs(x) > 0.03 * peak)[0]
        a = max(0, int(idx[0]) - int(0.03 * sr)); b = min(len(x), int(idx[-1]) + int(0.06 * sr))
        x = x[a:b] / peak * 0.89
    with wave.open(path_wav, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())


def main():
    clips = json.loads(subprocess.check_output(['node', os.path.join(ROOT, 'tools', 'voice', 'list.js')]))
    os.makedirs(OUT, exist_ok=True)
    index = {'format': 'ogg/opus', 'voices': {}}
    total = 0
    for name, (pv, scale, pitch) in VOICES.items():
        who = 'station' if name == 'st' else 'driver'
        todo = [c for c in clips if c['who'] == who]
        cdir = os.path.join(CACHE, name); os.makedirs(cdir, exist_ok=True)
        voice = None
        cfg = SynthesisConfig(length_scale=scale, noise_scale=0.5, noise_w_scale=0.6)
        blob = bytearray(); table = {}
        for i, c in enumerate(todo):
            h = hashlib.sha1((pv + '|' + str(scale) + '|' + str(pitch) + '|' + c['text']).encode('utf-8')).hexdigest()[:16]
            ogg = os.path.join(cdir, h + '.ogg')
            if not os.path.exists(ogg):
                if voice is None:
                    voice = PiperVoice.load(os.path.join(VOICE_DIR, 'ru_RU-%s-medium.onnx' % pv))
                wav = os.path.join(cdir, h + '.wav')
                synth(voice, cfg, c['text'], wav)
                af = [] if pitch == 1.0 else ['-af', 'asetrate=%d,aresample=24000,atempo=%.4f' % (round(22050 * pitch), 1 / pitch)]
                subprocess.check_call(['ffmpeg', '-v', 'error', '-y', '-i', wav] + af + ['-ac', '1', '-ar', '24000', '-c:a', 'libopus', '-b:a', '22k',
                                       '-application', 'voip', ogg])
                os.remove(wav)
            data = open(ogg, 'rb').read()
            table[c['id']] = [len(blob), len(data)]
            blob += data
            if i % 40 == 0:
                print(name, i, '/', len(todo), flush=True)
        with open(os.path.join(OUT, name + '.bin'), 'wb') as f:
            f.write(blob)
        index['voices'][name] = {'clips': table}
        total += len(blob)
        print(name, 'done', len(todo), 'clips', len(blob), 'bytes', flush=True)
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))
    print('ALL DONE total bytes', total, flush=True)


if __name__ == '__main__':
    main()
