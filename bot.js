const {
  Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, SlashCommandBuilder, REST, Routes, MessageType
} = require('discord.js');
const { Pool } = require('pg');
const fetch = require('node-fetch');

// ========== CONFIG ==========
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const ROLE_VERIFIE_ID = process.env.ROLE_VERIFIE_ID;
const SALON_MODERATION_ID = process.env.SALON_MODERATION_ID;
const SITE_URL = process.env.SITE_URL || 'https://vierif-site-web-production.up.railway.app';

const REQUIS = { TOKEN, CLIENT_ID, GUILD_ID, ROLE_VERIFIE_ID, SALON_MODERATION_ID };
for (const [nom, val] of Object.entries(REQUIS)) {
  if (!val) { console.error(`❌ Variable manquante : ${nom}`); process.exit(1); }
}
if (!process.env.DATABASE_URL) { console.error('❌ DATABASE_URL manquante.'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ========== UTILS ==========
function genererCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

// ========== CLIENT ==========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: ['CHANNEL', 'MESSAGE'],
});

// ========== COMMANDE /panel ==========
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
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Commande /panel enregistrée.');
  } catch (err) { console.error('❌ Erreur commande :', err); }
});

// ========== INTERACTIONS ==========
client.on(Events.InteractionCreate, async (interaction) => {
  // --- /panel ---
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
        '5️⃣ Un modérateur vérifie et tu reçois le rôle **Vérifié**\n\n' +
        '🛡️ **Aucune photo n\'est conservée.** Tu peux masquer ton visage si tu veux.\n\n' +
        '⚠️ **Si tu ne reçois pas le MP** : vérifie que tes messages privés sont ouverts.'
      )
      .setColor(0x5865F2);

    const bouton = new ButtonBuilder().setCustomId('verifier').setLabel('Vérifier').setStyle(ButtonStyle.Primary).setEmoji('✅');
    await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(bouton)] });
    return;
  }

  // --- Clic bouton Vérifier ---
  if (interaction.isButton() && interaction.customId === 'verifier') {
    const userId = interaction.user.id;
    let code;

    try {
      const { rows } = await pool.query('SELECT code FROM verifications WHERE discord_id = $1 AND valide = 0', [userId]);
      if (rows[0]) {
        code = rows[0].code;
      } else {
        code = genererCode();
        await pool.query('INSERT INTO verifications (code, discord_id, valide, a_moderer) VALUES ($1, $2, 0, 0)', [code, userId]);
      }
    } catch (err) {
      console.error('Erreur SQL:', err);
      return interaction.reply({ content: '❌ Erreur interne.', ephemeral: true });
    }

    try {
      await interaction.user.send(
        `🔑 **Ton code de vérification :** \`${code}\`\n\n` +
        `👉 Rends-toi sur ${SITE_URL}\n` +
        `Entre ce code, puis prends en photo ton carnet de correspondance.\n\n` +
        `🛡️ Ta photo ne sera pas conservée.`
      );
      await interaction.reply({ content: '✅ Je t\'ai envoyé ton code en MP !', ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: '❌ Je n\'ai pas pu t\'envoyer de MP. Active les messages privés du serveur.', ephemeral: true });
    }
    return;
  }
});

// ========== RÉACTION ✅ / ❌ DANS #moderation ==========
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  if (reaction.message.channel.id !== SALON_MODERATION_ID) return;

  // Récupère le message complet si partiel
  if (reaction.partial) {
    try { await reaction.fetch(); } catch (e) { return; }
  }

  const emoji = reaction.emoji.name;
  if (emoji !== '✅' && emoji !== '❌') return;

  // Cherche le code dans l'embed du message
  const embed = reaction.message.embeds[0];
  if (!embed || !embed.fields) return;

  const codeField = embed.fields.find(f => f.name === 'Code');
  if (!codeField) return;

  const code = codeField.value.replace(/`/g, '').trim();

  try {
    const { rows } = await pool.query('SELECT * FROM verifications WHERE code = $1', [code]);
    if (!rows[0]) {
      await reaction.message.reply({ content: `⚠️ Code \`${code}\` introuvable en base.` });
      return;
    }

    if (emoji === '✅') {
      await pool.query('UPDATE verifications SET valide = 1, a_moderer = 0 WHERE code = $1', [code]);
      await reaction.message.reply({ content: `✅ Code \`${code}\` approuvé par ${user.tag}. Le rôle sera attribué dans quelques secondes.` });
    } else {
      try {
        await fetch(`${SITE_URL}/api/supprimer-photo/${code}`, { method: 'DELETE' });
      } catch (e) { console.error('Erreur suppression photo:', e.message); }

      await pool.query('DELETE FROM verifications WHERE code = $1', [code]);
      await reaction.message.reply({ content: `❌ Code \`${code}\` refusé par ${user.tag}.` });
    }
  } catch (err) {
    console.error('Erreur traitement réaction :', err);
  }
});

// ========== POLLING : attribution des rôles ==========
setInterval(async () => {
  try {
    const { rows: valides } = await pool.query('SELECT * FROM verifications WHERE valide = 1');
    for (const ligne of valides) {
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const membre = await guild.members.fetch(ligne.discord_id).catch(() => null);
        if (!membre) {
          await pool.query('DELETE FROM verifications WHERE code = $1', [ligne.code]);
          continue;
        }

        if (!membre.roles.cache.has(ROLE_VERIFIE_ID)) {
          await membre.roles.add(ROLE_VERIFIE_ID);
          console.log(`✅ Rôle donné à ${membre.user.tag}`);

          try {
            await membre.send('🎉 Tu es maintenant vérifié ! Tu peux voir tous les salons du serveur.');
          } catch (e) {}

          try {
            const salonModo = await client.channels.fetch(SALON_MODERATION_ID);
            const embedModo = new EmbedBuilder()
              .setTitle('✅ Vérification validée')
              .setColor(0x57F287)
              .addFields(
                { name: 'Utilisateur', value: `<@${membre.id}> (\`${membre.user.tag}\`)`, inline: false },
                { name: 'ID Discord', value: `\`${membre.id}\``, inline: true },
                { name: 'Code', value: `\`${ligne.code}\``, inline: true }
              )
              .setThumbnail(membre.user.displayAvatarURL())
              .setTimestamp();
            await salonModo.send({ embeds: [embedModo] });
          } catch (e) { console.error('Erreur notif modération :', e.message); }
        }

        await pool.query('DELETE FROM verifications WHERE code = $1', [ligne.code]);
      } catch (err) { console.log(`Erreur rôle ${ligne.discord_id} : ${err.message}`); }
    }
  } catch (err) { console.error('Erreur polling rôles :', err.message); }
}, 10000);

client.login(TOKEN);