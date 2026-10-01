const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  AttachmentBuilder,
} = require('discord.js');

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// ========== CONFIG (variables d'environnement) ==========
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const ROLE_VERIFIE_ID = process.env.ROLE_VERIFIE_ID;
const SALON_MODERATION_ID = process.env.SALON_MODERATION_ID;
const SITE_URL = process.env.SITE_URL || 'https://ton-site.up.railway.app';
const DB_PATH = process.env.DB_PATH || './verif.db';

// Vérification des variables obligatoires
const REQUIS = { TOKEN, CLIENT_ID, GUILD_ID, ROLE_VERIFIE_ID, SALON_MODERATION_ID };
for (const [nom, val] of Object.entries(REQUIS)) {
  if (!val) {
    console.error(`❌ Variable d'environnement manquante : ${nom}`);
    process.exit(1);
  }
}

// ========== BASE DE DONNÉES ==========
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS verifications (
    code         TEXT PRIMARY KEY,
    discord_id   TEXT NOT NULL,
    valide       INTEGER DEFAULT 0,
    photo_path   TEXT,
    a_moderer    INTEGER DEFAULT 0,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ========== UTILITAIRES ==========
function genererCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ========== CLIENT DISCORD ==========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
});

// ========== ENREGISTREMENT DE LA COMMANDE /panel ==========
const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Déploie le panel de vérification dans ce salon')
    .setDefaultMemberPermissions(0)
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);

  try {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('✅ Commande /panel enregistrée.');
  } catch (err) {
    console.error('❌ Erreur enregistrement commande :', err);
  }
});

// ========== INTERACTIONS ==========
client.on(Events.InteractionCreate, async (interaction) => {
  // --- Commande /panel ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
    const embed = new EmbedBuilder()
      .setTitle('🔒 Vérification du serveur')
      .setDescription(
        'Pour accéder à tous les salons du serveur, tu dois vérifier que tu fais bien partie ' +
        'd\'un des lycées suivants :\n' +
        '• **Léon Chiris**\n' +
        '• **Amiral de Grasse**\n' +
        '• **Decroisset**\n\n' +
        '**Comment ça marche :**\n' +
        '1️⃣ Clique sur le bouton **Vérifier** ci-dessous\n' +
        '2️⃣ Le bot t\'enverra un **code en message privé (MP)**\n' +
        '3️⃣ Rends-toi sur le site et entre ce code : ' + SITE_URL + '\n' +
        '4️⃣ Prends une photo de ton **carnet de correspondance**\n' +
        '5️⃣ Tu recevras automatiquement le rôle **Vérifié**\n\n' +
        '⚠️ **Si tu ne reçois pas le MP** : vérifie que tes messages privés sont ouverts.\n' +
        '(Paramètres Discord → Confidentialité et sécurité → Autoriser les messages privés du serveur)'
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Une fois vérifié, tu verras tous les autres salons.' });

    const bouton = new ButtonBuilder()
      .setCustomId('verifier')
      .setLabel('Vérifier')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('✅');

    const row = new ActionRowBuilder().addComponents(bouton);

    await interaction.reply({ embeds: [embed], components: [row] });
    return;
  }

  // --- Clic sur le bouton Vérifier ---
  if (interaction.isButton() && interaction.customId === 'verifier') {
    const userId = interaction.user.id;

    const existant = db.prepare(
      'SELECT code FROM verifications WHERE discord_id = ? AND valide = 0'
    ).get(userId);

    let code;
    if (existant) {
      code = existant.code;
    } else {
      code = genererCode();
      db.prepare(
        'INSERT OR REPLACE INTO verifications (code, discord_id, valide, a_moderer) VALUES (?, ?, 0, 0)'
      ).run(code, userId);
    }

    try {
      await interaction.user.send(
        `🔑 **Ton code de vérification :** \`${code}\`\n\n` +
        `👉 Rends-toi sur ${SITE_URL}\n` +
        `Entre ce code, puis prends en photo ton carnet de correspondance.\n\n` +
        `Si tu as déjà reçu un code avant, ignore-le : celui-ci est le bon.`
      );

      await interaction.reply({
        content: '✅ Je t\'ai envoyé ton code en message privé ! Vérifie tes MP.',
        ephemeral: true,
      });
    } catch (err) {
      console.error('Impossible d\'envoyer le MP :', err);
      await interaction.reply({
        content:
          '❌ Je n\'ai pas pu t\'envoyer de message privé.\n\n' +
          'Va dans **Paramètres Discord → Confidentialité et sécurité** ' +
          'et active **Autoriser les messages privés du serveur**, puis réessaie.',
        ephemeral: true,
      });
    }
    return;
  }

  // --- Boutons de modération ---
  if (interaction.isButton() && interaction.customId.startsWith('mod_')) {
    const [action, code] = interaction.customId.split(':');

    const ligne = db.prepare('SELECT * FROM verifications WHERE code = ?').get(code);
    if (!ligne) {
      return interaction.reply({ content: 'Ce code n\'existe plus.', ephemeral: true });
    }

    if (action === 'mod_approuver') {
      db.prepare('UPDATE verifications SET valide = 1 WHERE code = ?').run(code);
      await interaction.reply({
        content: `✅ Code \`${code}\` approuvé. Le rôle sera donné dans quelques secondes.`,
        ephemeral: true,
      });
      await interaction.message.edit({ components: [] }).catch(() => {});
    } else {
      db.prepare('DELETE FROM verifications WHERE code = ?').run(code);
      await interaction.reply({ content: `❌ Code \`${code}\` refusé.`, ephemeral: true });
      await interaction.message.edit({ components: [] }).catch(() => {});
    }
    return;
  }
});

// ========== POLLING : rôle + envoi en modération ==========
setInterval(async () => {
  // 1) Donner le rôle aux validés
  const valides = db.prepare('SELECT * FROM verifications WHERE valide = 1').all();

  for (const ligne of valides) {
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const membre = await guild.members.fetch(ligne.discord_id).catch(() => null);

      if (!membre) {
        db.prepare('DELETE FROM verifications WHERE code = ?').run(ligne.code);
        continue;
      }

      if (!membre.roles.cache.has(ROLE_VERIFIE_ID)) {
        await membre.roles.add(ROLE_VERIFIE_ID);
        console.log(`✅ Rôle donné à ${membre.user.tag}`);

        try {
          await membre.send(
            '🎉 Tu es maintenant vérifié ! Tu peux voir tous les salons du serveur.'
          );
        } catch (e) {}
      }

      // Nettoyer la photo
      if (ligne.photo_path && fs.existsSync(ligne.photo_path)) {
        try { fs.unlinkSync(ligne.photo_path); } catch (e) {}
      }

      db.prepare('DELETE FROM verifications WHERE code = ?').run(ligne.code);
    } catch (err) {
      console.log(`Erreur rôle pour ${ligne.discord_id} : ${err.message}`);
    }
  }

  // 2) Envoyer en modération les photos non reconnues par l'OCR
  const aModerer = db.prepare(
    'SELECT * FROM verifications WHERE a_moderer = 1'
  ).all();

  for (const ligne of aModerer) {
    try {
      if (!ligne.photo_path || !fs.existsSync(ligne.photo_path)) {
        db.prepare('DELETE FROM verifications WHERE code = ?').run(ligne.code);
        continue;
      }

      const salon = await client.channels.fetch(SALON_MODERATION_ID);
      const membre = await client.users.fetch(ligne.discord_id).catch(() => null);

      const embed = new EmbedBuilder()
        .setTitle('🔍 Vérification à examiner')
        .setDescription(
          `**Utilisateur :** ${membre ? membre.tag : 'Inconnu'} (\`${ligne.discord_id}\`)\n` +
          `**Code :** \`${ligne.code}\`\n\n` +
          `L'OCR n'a pas trouvé automatiquement le nom d'un lycée sur la photo. ` +
          `Vérifie manuellement si le carnet est valide.`
        )
        .setColor(0xFEE75C)
        .setImage('attachment://carnet.jpg')
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mod_approuver:${ligne.code}`)
          .setLabel('Approuver')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`mod_refuser:${ligne.code}`)
          .setLabel('Refuser')
          .setStyle(ButtonStyle.Danger)
      );

      const fichier = new AttachmentBuilder(ligne.photo_path, { name: 'carnet.jpg' });

      await salon.send({ embeds: [embed], components: [row], files: [fichier] });

      db.prepare('UPDATE verifications SET a_moderer = 2 WHERE code = ?').run(ligne.code);
    } catch (err) {
      console.log(`Erreur modération pour ${ligne.code} : ${err.message}`);
    }
  }
}, 10000);

// ========== LOGIN ==========
client.login(TOKEN);