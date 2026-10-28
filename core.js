/* ============================================================================
 * core.js : noyau de stockage des visites (chiffrement, noms de fichiers,
 * résolution des versions). AUCUN accès disque, AUCUNE dépendance.
 *
 * Script classique (pas un module) : expose un seul objet global, NVCore.
 *
 * FORMAT D'UN FICHIER .enc (format_version = 1)
 *   octets 0-3   magic ASCII "NVIS"
 *   octet  4     format_version
 *   octets 5-6   key_id (entier 16 bits, big-endian)
 *   octets 7-18  IV (12 octets aléatoires, un nouvel IV par fichier)
 *   octets 19... texte chiffré AES-GCM (tag de 16 octets à la fin)
 * AAD (données authentifiées) = octets 0 à 6 : toute modification de l'en-tête
 * fait échouer le déchiffrement.
 *
 * Règle : decryptVersion renvoie un objet intact ou lève une NVError.
 * Jamais d'objet partiel ou « réparé ».
 * ========================================================================== */
const NVCore = (() => {
  'use strict';

  const MAGIC = new Uint8Array([0x4e, 0x56, 0x49, 0x53]); // "NVIS"
  const FORMAT_VERSION = 1;
  const SUPPORTED_FORMAT_VERSIONS = [1];
  const AAD_LEN = 7;              // magic (4) + format_version (1) + key_id (2)
  const IV_LEN = 12;
  const TAG_LEN = 16;
  const HEADER_LEN = AAD_LEN + IV_LEN;   // 19
  const MIN_LEN = HEADER_LEN + TAG_LEN;  // 35

  // ---------------------------------------------------------------- erreurs
  // Codes : TRUNCATED, BAD_MAGIC, UNSUPPORTED_VERSION, AUTH_FAILED,
  //         BAD_PAYLOAD, BAD_INPUT, NO_CRYPTO
  class NVError extends Error {
    constructor(code, message) {
      super(message || code);
      this.name = 'NVError';
      this.code = code;
    }
  }

  function subtle() {
    const c = globalThis.crypto;
    if (!c || !c.subtle) {
      throw new NVError('NO_CRYPTO', "WebCrypto indisponible (contexte non sécurisé ?)");
    }
    return c.subtle;
  }

  // ------------------------------------------------------------ utilitaires
  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    throw new NVError('BAD_INPUT', 'Uint8Array ou ArrayBuffer attendu');
  }
  function randomHex(nBytes) {
    const b = globalThis.crypto.getRandomValues(new Uint8Array(nBytes));
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }

  // ------------------------------------------------------------------- clés
  async function generateDataKey() {
    return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }
  async function exportKeyBase64(key) {
    const raw = await subtle().exportKey('raw', key);
    return bytesToBase64(new Uint8Array(raw));
  }
  async function importKeyBase64(b64) {
    let raw;
    try { raw = base64ToBytes(b64); }
    catch (e) { throw new NVError('BAD_INPUT', 'Clé base64 invalide'); }
    if (raw.length !== 32) throw new NVError('BAD_INPUT', 'La clé doit faire 32 octets');
    return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  // --------------------------------------------------- chiffrement / lecture
  async function encryptVersion(obj, key, keyId) {
    if (!Number.isInteger(keyId) || keyId < 0 || keyId > 0xffff) {
      throw new NVError('BAD_INPUT', 'key_id doit être un entier entre 0 et 65535');
    }
    const json = JSON.stringify(obj);
    if (json === undefined) throw new NVError('BAD_INPUT', 'Objet non sérialisable');
    const plain = new TextEncoder().encode(json);

    const header = new Uint8Array(AAD_LEN);
    header.set(MAGIC, 0);
    header[4] = FORMAT_VERSION;
    header[5] = (keyId >> 8) & 0xff;
    header[6] = keyId & 0xff;

    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ct = new Uint8Array(await subtle().encrypt(
      { name: 'AES-GCM', iv, additionalData: header, tagLength: TAG_LEN * 8 },
      key, plain));

    const out = new Uint8Array(HEADER_LEN + ct.length);
    out.set(header, 0);
    out.set(iv, AAD_LEN);
    out.set(ct, HEADER_LEN);
    return out;
  }

  async function decryptVersion(input, key) {
    const bytes = toBytes(input);
    if (bytes.length < MIN_LEN) {
      throw new NVError('TRUNCATED', 'Fichier trop court (' + bytes.length + ' octets)');
    }
    for (let i = 0; i < MAGIC.length; i++) {
      if (bytes[i] !== MAGIC[i]) throw new NVError('BAD_MAGIC', 'En-tête inconnu');
    }
    const formatVersion = bytes[4];
    if (!SUPPORTED_FORMAT_VERSIONS.includes(formatVersion)) {
      throw new NVError('UNSUPPORTED_VERSION', 'format_version ' + formatVersion + ' non supportée');
    }
    const keyId = (bytes[5] << 8) | bytes[6];
    const aad = bytes.subarray(0, AAD_LEN);
    const iv = bytes.subarray(AAD_LEN, HEADER_LEN);
    const ct = bytes.subarray(HEADER_LEN);

    let plain;
    try {
      plain = await subtle().decrypt(
        { name: 'AES-GCM', iv, additionalData: aad, tagLength: TAG_LEN * 8 },
        key, ct);
    } catch (e) {
      if (e instanceof NVError) throw e;
      throw new NVError('AUTH_FAILED', 'Déchiffrement impossible : mauvaise clé ou fichier altéré');
    }
    let obj;
    try { obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)); }
    catch (e) { throw new NVError('BAD_PAYLOAD', 'Contenu déchiffré illisible'); }
    return { obj, keyId, formatVersion };
  }

  // ------------------------------------------------------- noms de fichiers
  // v0007_<AUTEUR>_<AAAAMMJJ>T<HHMMSS>Z_<alea6hex>.enc
  const NAME_RE = /^v(\d{4})_([A-Z0-9]{1,8})_(\d{8}T\d{6}Z)_([0-9a-f]{6})\.enc$/;
  const pad = (n, l) => String(n).padStart(l || 2, '0');

  function formatDate(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) throw new NVError('BAD_INPUT', 'Date invalide');
    return pad(d.getUTCFullYear(), 4) + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
      'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }

  function buildFileName({ version, auteur, date, alea }) {
    if (!Number.isInteger(version) || version < 1 || version > 9999) {
      throw new NVError('BAD_INPUT', 'version doit être un entier entre 1 et 9999');
    }
    if (typeof auteur !== 'string' || !/^[A-Z0-9]{1,8}$/.test(auteur)) {
      throw new NVError('BAD_INPUT', 'auteur : 1 à 8 caractères A-Z0-9 (majuscules)');
    }
    const a = alea === undefined ? randomHex(3) : alea;
    if (typeof a !== 'string' || !/^[0-9a-f]{6}$/.test(a)) {
      throw new NVError('BAD_INPUT', 'alea : 6 caractères hexadécimaux minuscules');
    }
    return 'v' + pad(version, 4) + '_' + auteur + '_' + formatDate(date) + '_' + a + '.enc';
  }

  function parseFileName(nom) {
    if (typeof nom !== 'string') return null;
    const m = NAME_RE.exec(nom);
    if (!m) return null;
    const version = parseInt(m[1], 10);
    if (version < 1) return null;
    const s = m[3];
    const date = new Date(Date.UTC(
      +s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8),
      +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15)));
    if (formatDate(date) !== s) return null; // rejette p. ex. mois 13, 31 février
    return { version, auteur: m[2], date, dateStr: s, alea: m[4], nom };
  }

  // ------------------------------------------------- résolution des versions
  // Entrée : noms de fichiers d'UN dossier de visite (aucune lecture de contenu).
  // Sortie : {
  //   courante    : nom du fichier de la version la plus haute, ou null si
  //                 vide ou si cette version est en bifurcation
  //   bifurcations: [{ version, fichiers:[noms triés] }]  (tous niveaux, triés par version)
  //   ignores     : noms qui ne respectent pas le format exact
  //   lacunes     : numéros manquants entre 1 et la version max
  // }
  // Indépendant de l'ordre de la liste d'entrée.
  function resolveVersions(listeNoms) {
    const ignores = [];
    const parVersion = new Map();
    for (const nom of new Set(listeNoms || [])) {
      const p = parseFileName(nom);
      if (!p) { ignores.push(nom); continue; }
      if (!parVersion.has(p.version)) parVersion.set(p.version, []);
      parVersion.get(p.version).push(nom);
    }
    ignores.sort();
    const versions = [...parVersion.keys()].sort((a, b) => a - b);
    const bifurcations = [];
    for (const v of versions) {
      const fichiers = parVersion.get(v).slice().sort();
      if (fichiers.length > 1) bifurcations.push({ version: v, fichiers });
    }
    let courante = null;
    const lacunes = [];
    if (versions.length) {
      const max = versions[versions.length - 1];
      const top = parVersion.get(max);
      courante = top.length === 1 ? top[0] : null;
      for (let v = 1; v < max; v++) if (!parVersion.has(v)) lacunes.push(v);
    }
    return { courante, bifurcations, ignores, lacunes };
  }

  return {
    NVError, FORMAT_VERSION, HEADER_LEN, MIN_LEN,
    generateDataKey, exportKeyBase64, importKeyBase64,
    encryptVersion, decryptVersion,
    buildFileName, parseFileName, resolveVersions,
    _bytesToBase64: bytesToBase64
  };
})();

// Permet de tester le fichier aussi sous Node (inutile dans le navigateur).
if (typeof module !== 'undefined' && module.exports) module.exports = NVCore;
