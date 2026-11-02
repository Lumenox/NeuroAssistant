/* make_fixtures.js : génère les jeux de référence du lecteur de secours (Bloc 1bis).
 *
 * À EXÉCUTER UNE SEULE FOIS. Les fichiers produits sont ensuite GELÉS (stockés sur GitHub) :
 * on ne les régénère pas, sinon ils ne prouvent plus rien (chiffrement non déterministe : IV aléatoire).
 *
 * Usage : node make_fixtures.js <dossier_de_sortie>
 * La clé de test est PUBLIQUE (écrite dans TEST_KEY.txt) : elle ne doit jamais protéger de vraies données.
 */
const fs = require('fs');
const path = require('path');
const NVCore = require('./core.js');

const OUT = process.argv[2];
if (!OUT) { console.error('Usage : node make_fixtures.js <dossier_de_sortie>'); process.exit(1); }

const IPP = '9900000001', VID = 'visite-ref-0001', EPI = 'episode-ref-01';
const KEY_ID = 1;
const D0 = Date.UTC(2026, 10, 1, 9, 0, 0);          // 1er novembre 2026, 09:00:00 UTC
const nom = (version, auteur, sec, alea) => NVCore.buildFileName({ version, auteur, date: new Date(D0 + sec * 1000), alea });
const fid = n => NVCore.fidOf(n);
const rec = (version, parents, sec, over) => Object.assign({
  schema: 1, ipp: IPP, visite_id: VID, episode_id: EPI, version, parents, auteur: 'RM',
  date_saisie: new Date(D0 + sec * 1000).toISOString(), statut: 'actif',
  identite: { naissance: '1970-01-02', initiales: 'DM' },
  modeles: { mmse: '1' },
  items: { 'mmse.orientation.annee': 1, 'mmse.orientation.mois': 1, 'texte.libre': 'exemple, très ça va' }
}, over || {});
const flip = (b, i) => { const c = b.slice(); c[i] ^= 0xff; return c; };

(async () => {
  const key = await NVCore.generateDataKey();
  const autre = await NVCore.generateDataKey();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'TEST_KEY.txt'),
    '# CLÉ DE TEST PUBLIQUE : ne jamais utiliser pour de vraies données.\n# key_id = ' + KEY_ID + '\n' +
    KEY_ID + ':' + await NVCore.exportKeyBase64(key) + '\n');

  const cas = [];   // { dir, description, ctx, fichiers: [{nom, bytes}], extra? }
  const enc = (o, k) => NVCore.encryptVersion(o, k || key, KEY_ID);
  const F = async (n, o, k) => ({ nom: n, bytes: await enc(o, k) });
  const ctx = { ipp: IPP, visite_id: VID };

  // 01 visite normale
  { const n1 = nom(1, 'RM', 0, 'a00001'), n2 = nom(2, 'RM', 60, 'a00002'), n3 = nom(3, 'AB', 120, 'a00003');
    cas.push({ dir: '01_normale', description: 'Visite normale à 3 versions : une seule tête, version suivante 4', ctx,
      fichiers: [await F(n1, rec(1, [], 0)), await F(n2, rec(2, [fid(n1)], 60)), await F(n3, rec(3, [fid(n2)], 120, { auteur: 'AB' }))] }); }
  // 02 visite vide
  cas.push({ dir: '02_vide', description: 'Dossier sans aucun fichier .enc : état vide, version suivante 1', ctx, fichiers: [] });
  // 03 écriture interrompue
  { const n1 = nom(1, 'RM', 0, 'b00001'), n2 = nom(2, 'RM', 60, 'b00002'), n3 = nom(3, 'RM', 120, 'b00003');
    cas.push({ dir: '03_ecriture_interrompue', description: 'v2 est un fichier vide (écriture interrompue) ; v3 écrite ensuite depuis v1 : une tête (v3), v2 illisible, version suivante 4', ctx,
      fichiers: [await F(n1, rec(1, [], 0)), { nom: n2, bytes: new Uint8Array(0) }, await F(n3, rec(3, [fid(n1)], 120))] }); }
  // 04 bifurcation
  { const n1 = nom(1, 'RM', 0, 'c00001'), n2a = nom(2, 'PA', 60, 'c0bbbb'), n2b = nom(2, 'PB', 60, 'c0aaaa');
    cas.push({ dir: '04_bifurcation', description: 'Deux v2 issues de la même v1, même seconde : deux têtes, ordre départagé par l\'alea', ctx,
      fichiers: [await F(n1, rec(1, [], 0)), await F(n2a, rec(2, [fid(n1)], 60, { auteur: 'PA', items: { 'mmse.orientation.annee': 0 } })),
        await F(n2b, rec(2, [fid(n1)], 60, { auteur: 'PB', items: { 'mmse.orientation.annee': 1, 'mmse.orientation.mois': 0 } }))] }); }
  // 05 fusion
  { const n1 = nom(1, 'RM', 0, 'd00001'), n2a = nom(2, 'PA', 60, 'd0bbbb'), n2b = nom(2, 'PB', 60, 'd0aaaa'), n3 = nom(3, 'RM', 200, 'd00003');
    cas.push({ dir: '05_fusion', description: 'Bifurcation résolue par une v3 à deux parents : une seule tête (v3)', ctx,
      fichiers: [await F(n1, rec(1, [], 0)), await F(n2a, rec(2, [fid(n1)], 60, { auteur: 'PA' })), await F(n2b, rec(2, [fid(n1)], 60, { auteur: 'PB' })),
        await F(n3, rec(3, [fid(n2b), fid(n2a)], 200))] }); }
  // 06 parent manquant
  { const n1 = nom(1, 'RM', 0, 'e00001'), absent = nom(2, 'XX', 60, 'e00002'), n3 = nom(3, 'RM', 120, 'e00003');
    cas.push({ dir: '06_parent_manquant', description: 'v3 cite un parent v2 absent du dossier : signalé, sans bloquer', ctx,
      fichiers: [await F(n1, rec(1, [], 0)), await F(n3, rec(3, [fid(n1), fid(absent)], 120))] }); }
  // 07 fichiers altérés (une altération par fichier, tous enfants de v1)
  { const n1 = nom(1, 'RM', 0, 'f00001');
    const ok = await enc(rec(2, [fid(n1)], 60));
    const zones = [['magic', 0], ['format', 4], ['key_id', 5], ['iv', 10], ['contenu', 30], ['tag', ok.length - 1]];
    const fichiers = [await F(n1, rec(1, [], 0))];
    let k = 2;
    for (const [, idx] of zones) fichiers.push({ nom: nom(k, 'RM', 60 + k, 'f0000' + k), bytes: flip(ok, idx) }), k++;
    fichiers.push({ nom: nom(k, 'RM', 60 + k, 'f0000' + k), bytes: ok.slice(0, ok.length - 10) }); k++;
    fichiers.push({ nom: nom(k, 'RM', 60 + k, 'f0000' + k), bytes: ok.slice(0, 20) });
    cas.push({ dir: '07_altere', description: 'Huit fichiers altérés (en-tête, IV, contenu, tag, troncatures) : tous illisibles avec leur code, la v1 reste la courante', ctx, fichiers }); }
  // 08 mauvaise clé
  { const n1 = nom(1, 'RM', 0, '100001'), n2 = nom(2, 'RM', 60, '100002');
    cas.push({ dir: '08_mauvaise_cle', description: 'v1 chiffrée avec la bonne clé, v2 avec une autre clé : v2 illisible (AUTH_FAILED)', ctx,
      fichiers: [await F(n1, rec(1, [], 0)), await F(n2, rec(2, [fid(n1)], 60), autre)] }); }
  // 09 discordance
  { const n1 = nom(1, 'RM', 0, '200001'), n2 = nom(2, 'RM', 60, '200002'), n3 = nom(3, 'RM', 120, '200003'), n4 = nom(4, 'RM', 180, '200004');
    cas.push({ dir: '09_discordance', description: 'Contenus incompatibles avec le dossier ou le nom (autre IPP, autre visite, autre numéro) : MISMATCH, ignorés', ctx,
      fichiers: [await F(n1, rec(1, [], 0)), await F(n2, rec(2, [fid(n1)], 60, { ipp: '9900000002' })),
        await F(n3, rec(3, [fid(n1)], 120, { visite_id: 'autre-visite' })), await F(n4, rec(1, [], 180))] }); }
  // 10 pierre tombale puis restauration
  { const n1 = nom(1, 'RM', 0, '300001'), n2 = nom(2, 'RM', 60, '300002'), n3 = nom(3, 'AB', 120, '300003');
    cas.push({ dir: '10_tombstone_restauration', description: 'v2 annule (motif), v3 actif : la visite est restaurée, une seule tête (v3)', ctx,
      fichiers: [await F(n1, rec(1, [], 0)), await F(n2, rec(2, [fid(n1)], 60, { statut: 'annule', motif: 'saisie sur le mauvais patient' })),
        await F(n3, rec(3, [fid(n2)], 120, { auteur: 'AB' }))] }); }
  // 11 schema inconnu
  { const n1 = nom(1, 'RM', 0, '400001'), n2 = nom(2, 'RM', 60, '400002'), n3 = nom(3, 'RM', 120, '400003');
    cas.push({ dir: '11_schema_inconnu', description: 'v2 au schema 2 (inconnu) et v3 sans schema : illisibles (UNSUPPORTED_VERSION, BAD_PAYLOAD)', ctx,
      fichiers: [await F(n1, rec(1, [], 0)), await F(n2, rec(2, [fid(n1)], 60, { schema: 2 })),
        await F(n3, (() => { const o = rec(3, [fid(n1)], 120); delete o.schema; return o; })())] }); }
  // 12 noms non conformes
  { const n1 = nom(1, 'RM', 0, '500001');
    cas.push({ dir: '12_noms_non_conformes', description: 'Fichiers parasites dans le dossier : ignorés, sans effet sur la visite', ctx,
      fichiers: [await F(n1, rec(1, [], 0)), { nom: 'Thumbs.db', bytes: new Uint8Array([1, 2, 3]) },
        { nom: 'notes.txt', bytes: new TextEncoder().encode('bonjour') }, { nom: 'v1_RM.enc', bytes: new Uint8Array(40) }] }); }
  // 13 base périmée
  { const n1 = nom(1, 'RM', 0, '600001'), n2 = nom(2, 'PA', 60, '600002'), n3 = nom(3, 'PB', 90, '600003');
    cas.push({ dir: '13_base_perimee', description: 'v2 et v3 issues de la même v1 (base périmée) : bifurcation de numéros différents, version suivante 4', ctx,
      fichiers: [await F(n1, rec(1, [], 0)), await F(n2, rec(2, [fid(n1)], 60, { auteur: 'PA' })), await F(n3, rec(3, [fid(n1)], 90, { auteur: 'PB' }))] }); }
  // 14 redirection d'IPP
  { const n1 = nom(1, 'RM', 0, '700001'), n2 = nom(2, 'RM', 60, '700002');
    cas.push({ dir: '14_redirection_ipp', description: 'v2 annule avec redirige_vers explicite (correction d\'IPP) : lisible, une tête (v2)', ctx,
      fichiers: [await F(n1, rec(1, [], 0)), await F(n2, rec(2, [fid(n1)], 60, { statut: 'annule', motif: 'erreur d\'IPP',
        redirige_vers: { ipp: '9900000002', visite_id: 'visite-ref-0002' } }))] }); }

  const MAIN = {
    '01_normale': { etat: 'normal', tetes: 1, suivante: 4, codes: [], ignores: 0, manquants: 0 },
    '02_vide': { etat: 'vide', tetes: 0, suivante: 1, codes: [], ignores: 0, manquants: 0 },
    '03_ecriture_interrompue': { etat: 'normal', tetes: 1, suivante: 4, codes: ['TRUNCATED'], ignores: 0, manquants: 0 },
    '04_bifurcation': { etat: 'bifurcation', tetes: 2, suivante: 3, codes: [], ignores: 0, manquants: 0 },
    '05_fusion': { etat: 'normal', tetes: 1, suivante: 4, codes: [], ignores: 0, manquants: 0 },
    '06_parent_manquant': { etat: 'normal', tetes: 1, suivante: 4, codes: [], ignores: 0, manquants: 1 },
    '07_altere': { etat: 'normal', tetes: 1, suivante: 10, codes: ['BAD_MAGIC', 'UNSUPPORTED_VERSION', 'AUTH_FAILED', 'AUTH_FAILED', 'AUTH_FAILED', 'AUTH_FAILED', 'AUTH_FAILED', 'TRUNCATED'], ignores: 0, manquants: 0 },
    '08_mauvaise_cle': { etat: 'normal', tetes: 1, suivante: 3, codes: ['AUTH_FAILED'], ignores: 0, manquants: 0 },
    '09_discordance': { etat: 'normal', tetes: 1, suivante: 5, codes: ['MISMATCH', 'MISMATCH', 'MISMATCH'], ignores: 0, manquants: 0 },
    '10_tombstone_restauration': { etat: 'normal', tetes: 1, suivante: 4, codes: [], ignores: 0, manquants: 0 },
    '11_schema_inconnu': { etat: 'normal', tetes: 1, suivante: 4, codes: ['UNSUPPORTED_VERSION', 'BAD_PAYLOAD'], ignores: 0, manquants: 0 },
    '12_noms_non_conformes': { etat: 'normal', tetes: 1, suivante: 2, codes: [], ignores: 3, manquants: 0 },
    '13_base_perimee': { etat: 'bifurcation', tetes: 2, suivante: 4, codes: [], ignores: 0, manquants: 0 },
    '14_redirection_ipp': { etat: 'normal', tetes: 1, suivante: 3, codes: [], ignores: 0, manquants: 0 }
  };

  // Résolution attendue : calculée par core.js, puis figée dans expected.json (relue et vérifiée à la main au besoin).
  for (const c of cas) {
    const dir = path.join(OUT, c.dir);
    fs.mkdirSync(dir, { recursive: true });
    const entrees = [];
    for (const f of c.fichiers) {
      fs.writeFileSync(path.join(dir, f.nom), f.bytes);
      entrees.push(await NVCore.readEntry({ nom: f.nom, bytes: f.bytes, key, ipp: c.ctx.ipp, visite_id: c.ctx.visite_id }));
    }
    const r = NVCore.resolveGraph(entrees);
    const expected = {
      description: c.description, ctx: c.ctx, etat: r.etat, courante: r.courante, tetes: r.tetes, ordre: r.ordre,
      illisibles: r.illisibles.map(x => ({ nom: x.nom, code: x.code })), ignores: r.ignores,
      parentsManquants: r.parentsManquants, versionSuivante: r.versionSuivante
    };
    // Contrôle INDÉPENDANT : attentes écrites à la main, pour que expected.json ne soit pas simplement la sortie du code testé.
    const h = MAIN[c.dir];
    const codes = r.illisibles.map(x => x.code).sort().join(',');
    const ok = h && r.etat === h.etat && r.tetes.length === h.tetes && r.versionSuivante === h.suivante &&
      codes === h.codes.slice().sort().join(',') && r.ignores.length === h.ignores && r.parentsManquants.length === h.manquants;
    if (!ok) { console.error('ÉCART avec les attentes manuelles pour ' + c.dir, JSON.stringify({ etat: r.etat, tetes: r.tetes.length, suivante: r.versionSuivante, codes })); process.exit(2); }
    fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
    console.log(c.dir.padEnd(28), r.etat.padEnd(12), 'têtes=' + r.tetes.length, 'illisibles=' + r.illisibles.length, 'suivante=' + r.versionSuivante);
  }
})();
