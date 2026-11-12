# Сторонние компоненты и данные

| Компонент | Назначение | Лицензия |
|---|---|---|
| [Vosk](https://github.com/alphacep/vosk-api) и [vosk-browser 0.0.8](https://github.com/ccoreilly/vosk-browser) (`game/vendor/vosk.js`) | распознавание речи в браузере (WebAssembly) | Apache-2.0 |
| [vosk-model-small-ru-0.22](https://alphacephei.com/vosk/models) (`game/vosk/model-ru.tar.gz`, без языковой модели `Gr.fst`) | акустическая модель русского языка | Apache-2.0 |
| Голоса [Piper](https://github.com/OHF-Voice/piper1-gpl) `ru_RU-denis-medium`, `ru_RU-dmitri-medium` | заранее синтезированные реплики машинистов и дежурных (`game/voices/*`) | наборы данных — CC0; сам синтезатор в игру не входит |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | геометрия путей линии, станции, вода, границы города и районов (`game/data/geo.js`) | © участники OpenStreetMap, ODbL 1.0 |
| [Go](https://go.dev) | запускающая программа | BSD-3-Clause |

Игра — некоммерческий любительский проект. Она не связана с ГУП «Петербургский метрополитен»;
путевое развитие, графики и пассажиропотоки смоделированы приближённо по открытым источникам.
