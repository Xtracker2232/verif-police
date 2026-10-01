const {
  Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, SlashCommandBuilder, REST, Routes, AttachmentBuilder
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

// ========== POSTGRES ==========
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ========== UTILS ==========
function genererCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

// ========== CLIENT ==========
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages] });

// ========== COMMANDES ==========
const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Déploie le panel de vérification dans ce salon')
    .setDefaultMemberPermissions(0)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('reception')
    .setDescription('Affiche les vérifications en attente')
    .setDefaultMemberPermissions(0)
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Commandes /panel et /reception enregistrées.');
  } catch (err) { console.error('❌ Erreur commande :', err); }
});

// ========== ENVOYER UNE VÉRIFICATION DANS #moderation ==========
async function envoyerVerification(ligne) {
  const membre = await client.users.fetch(ligne.discord_id).catch(() => null);

  // Télécharge la photo depuis le site (HTTP), puis envoie en pièce jointe
  const photoUrl = `${SITE_URL}/photo/${ligne.code}`;
  let fichier = null;

  try {
    const response = await fetch(photoUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} en récupérant la photo`);
    }
    const buffer = await response.buffer();
    fichier = new AttachmentBuilder(buffer, { name: `carnet-${ligne.code}.jpg` });
  } catch (err) {
    console.error(`❌ Impossible de récupérer la photo pour ${ligne.code} :`, err.message);
    return false;
  }

  const embed = new EmbedBuilder()
    .setTitle('🔍 Vérification à examiner')
    .setColor(0xFEE75C)
    .addFields(
      { name: 'Utilisateur', value: membre ? `<@${membre.id}> (\`${membre.tag}\`)` : `\`${ligne.discord_id}\``, inline: false },
      { name: 'ID Discord', value: `\`${ligne.discord_id}\``, inline: true },
      { name: 'Code', value: `\`${ligne.code}\``, inline: true }
    )
    .setImage(`attachment://carnet-${ligne.code}.jpg`)
    .setFooter({ text: 'Vérifie que le carnet correspond à un des 3 lycées' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mod_approuver:${ligne.code}`).setLabel('Approuver').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`mod_refuser:${ligne.code}`).setLabel('Refuser').setStyle(ButtonStyle.Danger).setEmoji('❌')
  );

  try {
    const salon = await client.channels.fetch(SALON_MODERATION_ID);
    await salon.send({ embeds: [embed], components: [row], files: [fichier] });
    return true;
  } catch (err) {
    console.error(`❌ Erreur envoi Discord pour ${ligne.code} :`, err.message);
    return false;
  }
}

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

  // --- /reception : envoie toutes les photos en attente ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'reception') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const { rows } = await pool.query(
        'SELECT * FROM verifications WHERE a_moderer = 1 ORDER BY created_at ASC'
      );

      if (rows.length === 0) {
        return interaction.editReply({ content: '📭 Aucune vérification en attente.' });
      }

      await interaction.editReply({ content: `📬 Envoi de ${rows.length} vérification(s) en cours…` });

      let envoyees = 0;
      let erreurs = 0;

      for (const ligne of rows) {
        const ok = await envoyerVerification(ligne);
        if (ok) {
          await pool.query('UPDATE verifications SET a_moderer = 2 WHERE code = $1', [ligne.code]);
          envoyees++;
          console.log(`📤 Envoyée : ${ligne.code}`);
        } else {
          erreurs++;
        }
      }

      await interaction.editReply({
        content: `✅ ${envoyees} vérification(s) envoyée(s). ${erreurs > 0 ? `⚠️ ${erreurs} erreur(s).` : ''}`,
      });
    } catch (err) {
      console.error('❌ Erreur /reception :', err);
      await interaction.editReply({ content: '❌ Erreur lors de la récupération.' });
    }
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

  // --- Boutons modération ---
  if (interaction.isButton() && interaction.customId.startsWith('mod_')) {
    const [action, code] = interaction.customId.split(':');

    try {
      const { rows } = await pool.query('SELECT * FROM verifications WHERE code = $1', [code]);
      if (!rows[0]) return interaction.reply({ content: 'Ce code n\'existe plus.', ephemeral: true });

      if (action === 'mod_approuver') {
        await pool.query('UPDATE verifications SET valide = 1, a_moderer = 0 WHERE code = $1', [code]);
        await interaction.reply({ content: `✅ Code \`${code}\` approuvé. Le rôle sera donné dans quelques secondes.`, ephemeral: true });
      } else {
        // Prévient le site de supprimer la photo
        try {
          await fetch(`${SITE_URL}/api/supprimer-photo/${code}`, { method: 'DELETE' });
        } catch (e) { console.error('Erreur suppression photo:', e.message); }

        await pool.query('DELETE FROM verifications WHERE code = $1', [code]);
        await interaction.reply({ content: `❌ Code \`${code}\` refusé.`, ephemeral: true });
      }
      await interaction.message.edit({ components: [] }).catch(() => {});
    } catch (err) { console.error('Erreur modération :', err); }
    return;
  }
});

// ========== POLLING : envoi auto + attribution des rôles ==========
setInterval(async () => {
  // 1) Envoi automatique des nouvelles photos en modération
  try {
    const { rows: nouvelles } = await pool.query(
      'SELECT * FROM verifications WHERE a_moderer = 1 ORDER BY created_at ASC'
    );

    for (const ligne of nouvelles) {
      const ok = await envoyerVerification(ligne);
      if (ok) {
        await pool.query('UPDATE verifications SET a_moderer = 2 WHERE code = $1', [ligne.code]);
        console.log(`📤 Envoyée automatiquement : ${ligne.code}`);
      }
    }
  } catch (err) {
    console.error('Erreur polling envoi :', err.message);
  }

  // 2) Attribution des rôles
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