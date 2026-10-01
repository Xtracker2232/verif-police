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

const { Pool } = require('pg');
const fs = require('fs');

// ========== CONFIG ==========
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const ROLE_VERIFIE_ID = process.env.ROLE_VERIFIE_ID;
const SALON_MODERATION_ID = process.env.SALON_MODERATION_ID;
const SITE_URL = process.env.SITE_URL || 'https://vierif-site-web-production.up.railway.app';

const REQUIS = { TOKEN, CLIENT_ID, GUILD_ID, ROLE_VERIFIE_ID, SALON_MODERATION_ID };
for (const [nom, val] of Object.entries(REQUIS)) {
  if (!val) {
    console.error(`❌ Variable d'environnement manquante : ${nom}`);
    process.exit(1);
  }
}

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL manquante.');
  process.exit(1);
}

// ========== POSTGRES ==========
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ========== UTILS ==========
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

  // --- Clic bouton Vérifier ---
  if (interaction.isButton() && interaction.customId === 'verifier') {
    const userId = interaction.user.id;
    let code;

    try {
      const { rows } = await pool.query(
        'SELECT code FROM verifications WHERE discord_id = $1 AND valide = 0',
        [userId]
      );

      if (rows[0]) {
        code = rows[0].code;
      } else {
        code = genererCode();
        await pool.query(
          'INSERT INTO verifications (code, discord_id, valide, a_moderer) VALUES ($1, $2, 0, 0)',
          [code, userId]
        );
      }
    } catch (err) {
      console.error('Erreur SQL insert code :', err);
      return interaction.reply({
        content: '❌ Erreur interne. Réessaie dans quelques instants.',
        ephemeral: true,
      });
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

  // --- Boutons modération (Approuver / Refuser) ---
  if (interaction.isButton() && interaction.customId.startsWith('mod_')) {
    const [action, code] = interaction.customId.split(':');

    try {
      const { rows } = await pool.query(
        'SELECT * FROM verifications WHERE code = $1',
        [code]
      );

      if (!rows[0]) {
        return interaction.reply({ content: 'Ce code n\'existe plus.', ephemeral: true });
      }

      if (action === 'mod_approuver') {
        await pool.query(
          'UPDATE verifications SET valide = 1, lycee = $1, a_moderer = 0 WHERE code = $2',
          ['Validé manuellement', code]
        );
        await interaction.reply({
          content: `✅ Code \`${code}\` approuvé. Le rôle sera donné dans quelques secondes.`,
          ephemeral: true,
        });
      } else {
        await pool.query('DELETE FROM verifications WHERE code = $1', [code]);
        await interaction.reply({ content: `❌ Code \`${code}\` refusé.`, ephemeral: true });
      }

      await interaction.message.edit({ components: [] }).catch(() => {});
    } catch (err) {
      console.error('Erreur modération :', err);
    }
    return;
  }
});

// ========== POLLING ==========
setInterval(async () => {
  // 1) Donner le rôle + notifier dans #moderation
  try {
    const { rows: valides } = await pool.query(
      'SELECT * FROM verifications WHERE valide = 1'
    );

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
            await membre.send(
              '🎉 Tu es maintenant vérifié ! Tu peux voir tous les salons du serveur.'
            );
          } catch (e) {}

          // Notification dans #moderation
          try {
            const salonModo = await client.channels.fetch(SALON_MODERATION_ID);
            const embedModo = new EmbedBuilder()
              .setTitle('✅ Nouvelle vérification validée')
              .setColor(0x57F287)
              .addFields(
                { name: 'Utilisateur', value: `<@${membre.id}> (\`${membre.user.tag}\`)`, inline: false },
                { name: 'ID Discord', value: `\`${membre.id}\``, inline: true },
                { name: 'Lycée', value: ligne.lycee || 'Non précisé', inline: true },
                { name: 'Code', value: `\`${ligne.code}\``, inline: true }
              )
              .setThumbnail(membre.user.displayAvatarURL({ dynamic: true }))
              .setTimestamp();

            await salonModo.send({ embeds: [embedModo] });
          } catch (e) {
            console.error('Erreur envoi notification modération :', e.message);
          }
        }

        await pool.query('DELETE FROM verifications WHERE code = $1', [ligne.code]);
      } catch (err) {
        console.log(`Erreur rôle pour ${ligne.discord_id} : ${err.message}`);
      }
    }
  } catch (err) {
    console.error('Erreur polling rôles :', err.message);
  }

  // 2) Envoyer en modération les photos non reconnues
  try {
    const { rows: aModerer } = await pool.query(
      'SELECT * FROM verifications WHERE a_moderer = 1'
    );

    for (const ligne of aModerer) {
      try {
        if (!ligne.photo_path || !fs.existsSync(ligne.photo_path)) {
          console.log(`⚠️ Photo introuvable pour ${ligne.code}`);
          await pool.query('DELETE FROM verifications WHERE code = $1', [ligne.code]);
          continue;
        }

        const membre = await client.users.fetch(ligne.discord_id).catch(() => null);
        const fichier = new AttachmentBuilder(ligne.photo_path, { name: 'carnet.jpg' });

        const embed = new EmbedBuilder()
          .setTitle('🔍 Vérification à examiner')
          .setDescription(
            `**Utilisateur :** ${membre ? `<@${membre.id}> (\`${membre.tag}\`)` : `\`${ligne.discord_id}\``}\n` +
            `**Code :** \`${ligne.code}\`\n` +
            `**Statut :** ${ligne.lycee || 'En attente'}\n\n` +
            `Mindee n'a pas pu valider automatiquement ce carnet. ` +
            `Vérifie manuellement la photo ci-dessous.`
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

        const salon = await client.channels.fetch(SALON_MODERATION_ID);
        await salon.send({ embeds: [embed], components: [row], files: [fichier] });

        await pool.query('UPDATE verifications SET a_moderer = 2 WHERE code = $1', [ligne.code]);
      } catch (err) {
        console.log(`Erreur modération pour ${ligne.code} : ${err.message}`);
      }
    }
  } catch (err) {
    console.error('Erreur polling modération :', err.message);
  }
}, 10000);

// ========== LOGIN ==========
client.login(TOKEN);