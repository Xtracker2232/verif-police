const {
  Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, SlashCommandBuilder, REST, Routes, AttachmentBuilder
} = require('discord.js');
const { Pool } = require('pg');
const fs = require('fs');

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

function genererCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages] });

const commands = [new SlashCommandBuilder().setName('panel').setDescription('Déploie le panel de vérification').setDefaultMemberPermissions(0).toJSON()];
const rest = new REST({ version: '10' }).setToken(TOKEN);

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
  try { await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands }); console.log('✅ Commande /panel enregistrée.'); }
  catch (err) { console.error('❌ Erreur commande :', err); }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
    const embed = new EmbedBuilder().setTitle('🔒 Vérification du serveur')
      .setDescription('Pour accéder aux salons, vérifie que tu fais partie d\'un des lycées :\n• **Léon Chiris**\n• **Amiral de Grasse**\n• **Decroisset**\n\n' +
        '**Comment faire :**\n1️⃣ Clique sur **Vérifier**\n2️⃣ Reçois ton code en MP\n3️⃣ Va sur ' + SITE_URL + '\n4️⃣ Prends en photo ton carnet de correspondance\n5️⃣ Reçois le rôle **Vérifié**\n\n' +
        '⚠️ Si tu ne reçois pas le MP, active les messages privés du serveur.')
      .setColor(0x5865F2);
    const bouton = new ButtonBuilder().setCustomId('verifier').setLabel('Vérifier').setStyle(ButtonStyle.Primary).setEmoji('✅');
    await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(bouton)] });
    return;
  }

  if (interaction.isButton() && interaction.customId === 'verifier') {
    const userId = interaction.user.id; let code;
    try {
      const { rows } = await pool.query('SELECT code FROM verifications WHERE discord_id = $1 AND valide = 0', [userId]);
      if (rows[0]) code = rows[0].code;
      else { code = genererCode(); await pool.query('INSERT INTO verifications (code, discord_id, valide, a_moderer) VALUES ($1, $2, 0, 0)', [code, userId]); }
    } catch (err) { console.error('Erreur SQL:', err); return interaction.reply({ content: '❌ Erreur interne.', ephemeral: true }); }

    try {
      await interaction.user.send(`🔑 **Ton code :** \`${code}\`\n\n👉 Va sur ${SITE_URL}\nEntre ce code, puis prends en photo ton carnet de correspondance.`);
      await interaction.reply({ content: '✅ Je t\'ai envoyé ton code en MP !', ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: '❌ Je n\'ai pas pu t\'envoyer de MP. Active les messages privés du serveur dans tes paramètres Discord.', ephemeral: true });
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('mod_')) {
    const [action, code] = interaction.customId.split(':');
    try {
      const { rows } = await pool.query('SELECT * FROM verifications WHERE code = $1', [code]);
      if (!rows[0]) return interaction.reply({ content: 'Ce code n\'existe plus.', ephemeral: true });

      if (action === 'mod_approuver') {
        await pool.query('UPDATE verifications SET valide = 1, lycee = $1, a_moderer = 0 WHERE code = $2', ['Validé manuellement', code]);
        await interaction.reply({ content: `✅ Code \`${code}\` approuvé.`, ephemeral: true });
      } else {
        await pool.query('DELETE FROM verifications WHERE code = $1', [code]);
        await interaction.reply({ content: `❌ Code \`${code}\` refusé.`, ephemeral: true });
      }
      await interaction.message.edit({ components: [] }).catch(() => {});
    } catch (err) { console.error('Erreur modération :', err); }
    return;
  }
});

setInterval(async () => {
  try {
    const { rows: valides } = await pool.query('SELECT * FROM verifications WHERE valide = 1');
    for (const ligne of valides) {
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const membre = await guild.members.fetch(ligne.discord_id).catch(() => null);
        if (!membre) { await pool.query('DELETE FROM verifications WHERE code = $1', [ligne.code]); continue; }

        if (!membre.roles.cache.has(ROLE_VERIFIE_ID)) {
          await membre.roles.add(ROLE_VERIFIE_ID);
          console.log(`✅ Rôle donné à ${membre.user.tag}`);
          try { await membre.send('🎉 Tu es maintenant vérifié !'); } catch (e) {}

          try {
            const salonModo = await client.channels.fetch(SALON_MODERATION_ID);
            const embedModo = new EmbedBuilder().setTitle('✅ Nouvelle vérification validée').setColor(0x57F287)
              .addFields(
                { name: 'Utilisateur', value: `<@${membre.id}> (\`${membre.user.tag}\`)`, inline: false },
                { name: 'ID Discord', value: `\`${membre.id}\``, inline: true },
                { name: 'Lycée', value: ligne.lycee || 'Non précisé', inline: true },
                { name: 'Code', value: `\`${ligne.code}\``, inline: true }
              ).setThumbnail(membre.user.displayAvatarURL()).setTimestamp();
            await salonModo.send({ embeds: [embedModo] });
          } catch (e) { console.error('Erreur notif modération :', e.message); }
        }
        await pool.query('DELETE FROM verifications WHERE code = $1', [ligne.code]);
      } catch (err) { console.log(`Erreur rôle ${ligne.discord_id} : ${err.message}`); }
    }
  } catch (err) { console.error('Erreur polling rôles :', err.message); }

  try {
    const { rows: aModerer } = await pool.query('SELECT * FROM verifications WHERE a_moderer = 1');
    for (const ligne of aModerer) {
      try {
        if (!ligne.photo_path || !fs.existsSync(ligne.photo_path)) {
          await pool.query('DELETE FROM verifications WHERE code = $1', [ligne.code]); continue;
        }
        const membre = await client.users.fetch(ligne.discord_id).catch(() => null);
        const fichier = new AttachmentBuilder(ligne.photo_path, { name: 'carnet.jpg' });

        const embed = new EmbedBuilder().setTitle('🔍 Vérification à examiner')
          .setDescription(`**Utilisateur :** ${membre ? `<@${membre.id}>` : `\`${ligne.discord_id}\``}\n**Code :** \`${ligne.code}\`\n**Statut :** ${ligne.lycee || 'En attente'}\n\nMindee n'a pas pu valider automatiquement. Vérifie la photo ci-dessous.`)
          .setColor(0xFEE75C).setImage('attachment://carnet.jpg').setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`mod_approuver:${ligne.code}`).setLabel('Approuver').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`mod_refuser:${ligne.code}`).setLabel('Refuser').setStyle(ButtonStyle.Danger)
        );

        const salon = await client.channels.fetch(SALON_MODERATION_ID);
        await salon.send({ embeds: [embed], components: [row], files: [fichier] });
        await pool.query('UPDATE verifications SET a_moderer = 2 WHERE code = $1', [ligne.code]);
      } catch (err) { console.log(`Erreur modération ${ligne.code} : ${err.message}`); }
    }
  } catch (err) { console.error('Erreur polling modération :', err.message); }
}, 10000);

client.login(TOKEN);