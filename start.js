const { fork } = require('child_process');

console.log('🚀 Démarrage du site et du bot...');

const site = fork('./server.js');
const bot = fork('./bot.js');

site.on('exit', (code) => {
  console.log(`⚠️ Le site s'est arrêté (code ${code}). Redémarrage...`);
  process.exit(1); // Railway relance tout
});

bot.on('exit', (code) => {
  console.log(`⚠️ Le bot s'est arrêté (code ${code}). Redémarrage...`);
  process.exit(1);
});

process.on('SIGTERM', () => {
  site.kill();
  bot.kill();
  process.exit(0);
});