// Печатает JSON со всеми фразами радиообмена для генератора озвучки.
globalThis.M = {};
for (const f of ['util', 'line', 'phrases']) require('../../game/js/' + f + '.js');
process.stdout.write(JSON.stringify(M.allClips()));
