# Bloc 2 — Spécification du stockage des visites (brouillon 1)

Statut : **version 1, décisions du 1er novembre 2026 intégrées**. Aucun point bloquant n'est ouvert ; les questions restantes sont au § 17.
Ce document est normatif une fois validé : le code (`core.js`) et le lecteur de secours s'y conforment, pas l'inverse.
Il remplace, pour le format et les règles de version, les sections correspondantes de `BLOC0_decisions.md` ; il s'appuie sur les mesures de `BLOC1_bilan.md`.

Mots-clés : DOIT / NE DOIT PAS / DEVRAIT sont employés au sens usuel des spécifications.

## 1. Principes

1. Un enregistrement = un fichier chiffré, **jamais modifié, renommé ni supprimé** par l'application.
2. Une visite est un dossier ; son historique est l'ensemble de ses fichiers.
3. L'exactitude des données **ne dépend ni des horloges ni de la visibilité immédiate** des fichiers entre postes.
4. Un fichier illisible ne bloque jamais la visite : il est ignoré et signalé.
5. L'application ne répare, ne fusionne et n'« améliore » jamais un contenu sans geste explicite de l'utilisateur.

## 2. Arborescence

```
<racine>/patients/<SS>/<IPP>/<visite_id>/<fichier>.enc
```

- `<IPP>` : identifiant patient, exactement 10 chiffres `[0-9]{10}`.
- `<SS>` : niveau de partitionnement = **deux derniers chiffres de l'IPP** (100 sous-dossiers).
  - Motif (bilan, § 3.3) : le listage d'un dossier coûte de plus en plus par entrée ; 100 sous-dossiers ramènent chaque listage à quelques dizaines d'entrées.
  - Un accès par IPP ne coûte pas plus cher : le chemin est connu directement.
- `<visite_id>` : identifiant opaque (UUID v4 en minuscules sans tiret, ou court aléatoire ≥ 12 caractères hexadécimaux).
- L'épisode n'est **pas** dans le chemin : il figure dans le contenu (`episode_id`).
- Les dossiers sont créés à la demande. Aucun autre fichier n'est attendu dans un dossier de visite ; tout nom non conforme est ignoré (et listé en diagnostic).

## 3. Nom de fichier

```
v<NNNN>_<AUTEUR>_<AAAAMMJJ>T<HHMMSS>Z_<alea6hex>.enc
```

- `NNNN` : numéro de version, 4 chiffres, 1 à 9999.
- `AUTEUR` : 1 à 8 caractères `[A-Z0-9]`.
- Horodatage : UTC, horloge du poste, à la seconde.
- `alea6hex` : 6 chiffres hexadécimaux minuscules tirés au hasard à chaque écriture.
- **fid** (identité du fichier) : le nom **sans** l'extension `.enc`. Le fid est unique dans un dossier de visite.

Le numéro de version est un **repère de tri et d'affichage**, pas une identité : deux fichiers peuvent porter le même numéro (voir § 6).

## 4. Conteneur chiffré (format_version = 1, inchangé)

| Octets | Contenu |
|---|---|
| 0–3 | `NVIS` |
| 4 | format_version (1) |
| 5–6 | key_id (entier 16 bits, big-endian) |
| 7–18 | IV (12 octets aléatoires, un nouvel IV par fichier) |
| 19… | texte chiffré AES-256-GCM, étiquette de 16 octets à la fin |

AAD = octets 0 à 6. Taille minimale : 35 octets. Voir `core.js` (`NVCore`).

## 5. Contenu (JSON UTF-8), `schema` = 1

```json
{
  "schema": 1,
  "ipp": "…",
  "visite_id": "…",
  "episode_id": "…",
  "version": 3,
  "parents": ["v0002_AB_20261030T100211Z_a1b2c3", "v0002_CD_20261030T100211Z_9f8e7d"],
  "auteur": "AB",
  "date_saisie": "2026-10-30T10:02:11.482Z",
  "statut": "actif",
  "motif": null,
  "identite": { "naissance": "AAAA-MM-JJ", "initiales": "XY" },
  "modeles": { "<test_id>": "<version de la définition>" },
  "items": { "<item_id>": "<valeur>" }
}
```

Règles :
- `schema`, `ipp`, `visite_id`, `episode_id`, `version`, `parents`, `auteur`, `date_saisie`, `statut` : obligatoires.
- `ipp`, `visite_id` et `version` DOIVENT concorder avec le chemin et le nom du fichier. Sinon le fichier est **illisible** (§ 6.2).
- `parents` : liste des fid des versions dont celle-ci est issue, **sans doublon**, chaque parent ayant un numéro **strictement inférieur** au numéro de la version (évite tout cycle). Vide pour la première version ; un élément pour une suite ; deux ou plus pour une fusion.
- `motif`, `identite`, `modeles`, `items`, `redirige_vers`, `origine` sont facultatifs, mais validés s'ils sont présents (`items` absent équivaut à `{}`).
- `items` : seulement les items renseignés. Absent = non renseigné. Les totaux et scores dérivés sont **recalculés à l'affichage**, jamais stockés.
- `statut` : `actif` ou `annule`. Pour `annule`, `motif` est une chaîne non vide **obligatoire**.
- `identite` : confirmée à chaque ouverture de visite (Bloc 0). Les initiales sont les premières lettres du nom et du prénom.
- La version nouvelle contient **l'état complet** de la visite (pas un delta) : lire la tête suffit.
- Champs inconnus : **conservés** à la réécriture (recopiés tels quels dans la nouvelle version), ignorés pour l'affichage, jamais supprimés.
- `redirige_vers` : objet `{ipp, visite_id}`, **obligatoire** quand une version `annule` redirige la visite vers un autre dossier (§ 11) ; absent sinon.
- `origine` : objet `{ipp, visite_id, fid}`, présent dans la première version d'une visite créée par redirection (§ 11) ; absent sinon.

Les fichiers du spike (`parent_version`, pas de `schema`) sont fictifs et **non supportés** : ils seront purgés.

## 6. Règles de résolution (normatives)

Entrée : le contenu d'un dossier de visite. Sortie : un état parmi `vide`, `normal` (une tête), `bifurcation` (≥ 2 têtes).

### 6.1 Liste
Lister les noms ; ignorer ceux qui ne respectent pas le format du § 3.

### 6.2 Fichier lisible
Un fichier est **lisible** s'il se déchiffre avec la clé indiquée par son `key_id`, si le JSON est valide, si `schema` est connu et si les concordances du § 5 sont satisfaites. Sinon il est **illisible** : ignoré pour la résolution, listé avec son code d'erreur (`TRUNCATED`, `BAD_MAGIC`, `UNSUPPORTED_VERSION`, `AUTH_FAILED`, `BAD_PAYLOAD`, `MISMATCH`).
Un fichier vide ou tronqué (écriture interrompue) est donc illisible, pas corrompu au sens grave.

### 6.3 Graphe
Les nœuds sont les fichiers lisibles ; chaque fid de `parents` est une arête vers un nœud. Un parent absent ou illisible est signalé (`PARENT_MANQUANT`) mais ne bloque pas.
Une **tête** est un nœud qui n'est le parent d'aucun autre nœud lisible.

### 6.4 État
- 0 nœud : `vide`.
- 1 tête : `normal`, la version courante est cette tête.
- ≥ 2 têtes : `bifurcation`.

### 6.5 Ordre total (affichage et départage)
Tous les nœuds sont triés par : (1) horodatage du nom, (2) `alea6hex`, ordre croissant.
- Cet ordre est identique pour tous les postes et ne dépend d'aucune lecture de métadonnées.
- La date de modification du NAS (`lastModified`) peut être affichée à titre **indicatif**. Elle NE DOIT PAS servir à décider : elle change à la copie ou à la restauration d'une sauvegarde.
- En cas de bifurcation, l'ordre indique quelle branche est « arrivée en dernier » ; il ne signifie pas que cette branche est fautive : les deux auteurs ignoraient l'autre.

### 6.6 Numéro de la version suivante
`version = 1 + max(numéros des noms de fichiers présents, y compris illisibles)`.
Cela évite de réutiliser le numéro d'un fichier vide laissé par une écriture interrompue.

## 7. Protocole d'écriture

1. Vérifier les identifiants (`ipp`, `visite_id`).
2. Créer les dossiers manquants.
3. Lister le dossier de la visite (ouverture de lecture fraîche) et calculer l'état (§ 6).
4. Si une tête plus récente que la base de l'utilisateur est visible : **avertir** (« modifiée par X à HH:MM depuis votre ouverture ») et proposer d'afficher cette version avant d'enregistrer. L'utilisateur peut passer outre ; l'écriture reste possible (ajout seul).
5. `parents` = la ou les têtes sur lesquelles l'utilisateur s'est basé. Si l'état est `bifurcation`, l'enregistrement est une **résolution** (§ 8) et prend toutes les têtes.
6. Choisir un nom libre (jusqu'à 5 essais), chiffrer, créer le fichier, écrire, fermer.
7. Relire le fichier, le déchiffrer et le comparer à ce qui a été écrit. Écart ou erreur = enregistrement **non confirmé** (message clair, brouillon conservé).
8. Programmer **une** relecture du dossier environ 12 s plus tard (§ 9).

Erreurs transitoires du navigateur (`InvalidStateError`, `NotReadableError`, `NoModificationAllowedError`) :
- listages, relectures, création du fichier et `createWritable` sont rejoués jusqu'à 4 fois avec attente croissante ;
- `write` + `close` NE DOIVENT PAS être rejoués automatiquement (risque de double écriture) ; l'échec est présenté à l'utilisateur ;
- l'étape fautive figure dans le message d'erreur.

Politique d'enregistrement (décidée) : **une version par action explicite « Enregistrer »**. Pas de versionnage automatique à chaque frappe. Un brouillon local (stockage du navigateur) protège la saisie en cours ; il n'est pas une donnée de référence.
Motif : volume (≈ 36 000 visites par an) et lisibilité de l'historique.

## 8. Résolution d'une bifurcation

- Détectée (§ 9), elle est signalée sur la visite et à l'ouverture.
- L'écran affiche les branches dans l'ordre du § 6.5, avec auteur, heure et items différents.
- Résoudre = écrire une version dont `parents` contient **toutes** les têtes, avec un contenu choisi par l'utilisateur : une des branches, ou une combinaison.
- Aucun fichier n'est renommé ni supprimé.
- Fusion automatique (items disjoints entre les branches) : **hors périmètre de cette version**. Le champ `parents` multiple la rend possible plus tard sans changer le format.

## 9. Détection a posteriori

Moments : à chaque ouverture de visite, et une fois environ 12 s après un enregistrement.
Motif : la visibilité d'un fichier écrit par un autre poste peut être retardée jusqu'à environ 10 s (mesure, bilan § 3.4 ; hypothèse du cache SMB non confirmée).
Un conflit détecté DOIT être visible pour tous les utilisateurs qui ouvrent la visite, tant qu'il n'est pas résolu. Il NE DOIT PAS empêcher la lecture.

## 10. Annulation (pierre tombale)

- Annuler = écrire une version `statut: "annule"` avec un `motif` non vide.
- Une visite annulée est masquée des vues par défaut, visible sur demande, restaurable par une nouvelle version `actif`.
- Aucun fichier n'est supprimé.

## 11. Correction d'IPP

Un fichier ne change jamais de dossier. Si une visite a été saisie sous un mauvais IPP :
1. écrire une version `annule` dans l'ancienne visite, avec `motif` et `redirige_vers: {ipp, visite_id}` **explicite et obligatoire** : une annulation par erreur d'IPP sans destination est refusée ;
2. créer dans le bon IPP une visite dont la première version porte `origine: {ipp, visite_id, fid}` et reprend les items.
Décidé. Les deux champs figurent au § 5.

## 12. Navigation et index

- L'accès normal se fait par IPP : chemin direct, un listage de dossier de visites.
- Aucun parcours complet de la base en usage interactif (bilan : 10 à 60 min pour 36 000 visites).
- Les listes transversales (visites du jour, recherche) relèvent d'un **index dérivé**, reconstructible depuis les fichiers et jetable ; il est traité au Bloc 5, pas ici.
- L'export pour la recherche est un traitement par lots, hors interface de saisie.

## 13. Sécurité

- Chiffrement : AES-256-GCM, clé de données (DEK) avec `key_id`, sauvegarde hors ligne dès le premier jour, enveloppes individuelles de superadmins plus tard (Bloc 0).
- Modèle de menace : copie du fichier hors du NAS, pas un collègue autorisé.
- **Fuite de métadonnées (acceptée par le responsable du projet le 1er novembre 2026 ; à porter à la connaissance du DPO)** : les noms de dossiers et de fichiers ne sont pas chiffrés. Une copie hors NAS expose, sans la clé : l'IPP (nom de dossier), le nombre de visites et de versions, les dates et heures d'écriture, les codes auteurs. L'IPP est un identifiant hospitalier ; cette exposition est acceptée : l'accès au NAS passe par la même session nominative que celui d'Orbis, dont la compromission serait plus grave. Option écartée pour l'instant : dossier patient opaque dérivé de l'IPP par un secret (HMAC), au prix d'un lecteur de secours plus lourd et d'un retour à l'IPP impossible sans le secret.
- Bibliothèques dans `vendor/`, pas de CDN ; aucune donnée sensible dans le code public ; données fictives uniquement pendant le prototypage.

## 14. Compatibilité et évolution

- `format_version` (conteneur) et `schema` (contenu) évoluent séparément.
- Un lecteur NE DOIT PAS modifier un fichier d'une version qu'il ne connaît pas ; il l'ignore et le signale.
- Les fichiers existants ne sont jamais migrés sur place : une nouvelle version est écrite au nouveau schéma.

## 15. Jeux de test à figer (Bloc 1bis)

Fichiers de référence chiffrés avec une clé de test publique, avec le résultat attendu de la résolution :

1. visite normale à 3 versions ;
2. visite vide ;
3. écriture interrompue (fichier vide) suivie d'une version valide ;
4. bifurcation à deux têtes de même numéro ;
5. bifurcation puis fusion à deux parents ;
6. parent manquant ;
7. fichier altéré (chaque zone de l'en-tête, texte chiffré) ;
8. mauvaise clé ;
9. `ipp` ou `version` discordant avec le chemin ou le nom (`MISMATCH`) ;
10. pierre tombale avec motif, puis restauration ;
11. `schema` inconnu ;
12. nom de fichier non conforme.

Chaque cas est vérifié par les tests automatiques (`tests.html`, tests B2-01 à B2-16) ; les fichiers chiffrés figés pour le lecteur de secours restent à produire (Bloc 1bis).

Réalisé le 1er novembre 2026 (Bloc 1bis) : les 12 cas ci-dessus plus 2 (base périmée, redirection d'IPP) sont figés dans `fixtures/` (un dossier par cas, `expected.json` par cas, clé publique dans `TEST_KEY.txt`, `key_id` 1), produits une seule fois par `make_fixtures.js`. **Ces fichiers sont gelés : on ne les régénère pas** (le chiffrement n'étant pas déterministe, une régénération ne prouverait plus rien). Le lecteur de secours `rescue.html` sait les vérifier lui-même.

## 16. Code correspondant

Réalisé le 1er novembre 2026 (`core.js`, `tests.html` : 50 tests, dont les 12 cas du § 15) :
- `NVCore.validateContent` (§ 5), `readEntry` (déchiffre et valide, ne lève jamais), `resolveGraph` (§ 6), `buildContent` (§ 7 et § 5 : version, parents, champs inconnus recopiés) ;
- `resolveVersions` est conservée pour l'inventaire par les noms ;
- code d'erreur ajouté : `MISMATCH`.

Reste à faire :
- `spike.html` reste un outil de mesure sur l'ancien contenu (`parent_version`) ; la couche de stockage de l'application finale reprendra `nvRetry`, `nvWriteVersion`, `nvReadVisit` avec ce contenu et `resolveGraph` ;
- refus d'une annulation « erreur d'IPP » sans `redirige_vers` : à appliquer dans l'interface (le noyau ne connaît pas la raison de l'annulation) ;
- compléter le lecteur de secours si la spécification change (`schema` 2 : nouveaux cas figés, anciens cas conservés).

## 17. Questions ouvertes

Tranchées le 1er novembre 2026 : format des IPP (10 chiffres), exposition des métadonnées (acceptée), une version par « Enregistrer », champs inconnus conservés, redirection d'IPP explicite.

Restent ouvertes :
1. Test de l'hypothèse du cache SMB ; revalidation de la reprise d'erreurs sur le NAS réel.
2. Avis du DPO (dont l'exposition des métadonnées du § 13).
3. Questions du Bloc 0 : type d'épisode `avis` / `recherche`, journal de synchronisation, sauvegarde du NAS, migration des anciens `.db`, date de naissance ou âge, dépendance à Internet, détenteurs des clés superadmin.
