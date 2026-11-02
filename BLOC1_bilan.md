# Bloc 1 — Bilan du spike sur le NAS réel

Date : 30 octobre 2026
Outil de mesure : `spike.html` + `core.js` (données fictives uniquement, IPP `99xxxxxx`)
Conditions : NAS réel, deux postes Windows (sessions nominatives), Chrome 156, clé de test identique sur les deux postes.

## 1. Question posée

Un stockage par fichiers chiffrés, un fichier par version, jamais écrasé, sur un NAS partagé, sans serveur, est-il assez rapide, assez sûr et assez robuste aux accès simultanés pour porter l'outil ?

## 2. Verdict

**GO** pour le principe : fichiers chiffrés versionnés, ajout seul, sans verrou sur le NAS.
**NO-GO** pour un verrou fondé sur des fichiers du NAS (voir 4.3).
Trois points sont à traiter dans la spécification du Bloc 2 : détection a posteriori des bifurcations, partitionnement du dossier `patients`, reprise sur erreurs transitoires du navigateur.

## 3. Mesures

### 3.1 Intégrité

| Test | Résultat |
|---|---|
| Génération de 5 000 visites (9 185 fichiers) | 0 échec |
| Génération simultanée depuis les deux postes (500 visites chacun) | 927 + 909 fichiers, 0 échec |
| Analyse finale : 6 000 visites, 11 021 fichiers (= 9 185 + 927 + 909) | 0 illisible, 0 bifurcation non voulue |
| Écritures relues et comparées après chaque enregistrement | 0 écart |

Aucune perte ni corruption sur toute la série.

### 3.2 Écriture

| Concurrence | Débit (fichiers/s) | Remarque |
|---|---|---|
| 1 | 2,0 | |
| 4 | 4,8 à 5,6 | médiane 650–730 ms, p95 ≈ 1,2 s, max jusqu'à 4,8 s |
| 8 | 5,7 | pas de gain notable |

Deux postes qui écrivent en même temps atteignent chacun ≈ 5,2–5,6 fichiers/s. La limite est donc **par poste**, pas celle du NAS.

### 3.3 Lecture

- **M1 (ouvrir un patient)** : 43–57 ms (médiane) à chaud ; 162 ms (médiane), p95 330 ms, à froid depuis le second poste.
- **Lister `patients`** (1 446 entrées) : 2,9 à 7,3 s. Le coût par entrée passe de 0,4 ms (58 entrées) à 2–5 ms (1 446 entrées) : il croît plus vite que le nombre d'entrées.
- **M2 (parcourir toutes les visites)** : noms seuls 54–60 visites/s (≈ 10–11 min extrapolées pour 36 000 visites) ; avec déchiffrement ≈ 13 visites/s seul, ≈ 10 visites/s par poste quand les deux lisent ensemble (45–60 min extrapolées).

Conséquence : un parcours complet de la base n'est pas une opération interactive. L'usage normal (accès direct par IPP) l'est.

### 3.4 Visibilité entre postes (M8)

**Ping-pong** (A écrit, B répond, relecture en boucle toutes les 100 ms) :
- aller-retour mesuré : 10,07 à 10,55 s (médiane 10,13 s, 9 tours) ;
- écritures : 0,25–0,93 s (A), 0,26–0,50 s (B) ;
- quand le nom d'un fichier apparaît, son contenu est déjà lisible ;
- la distribution est très étroite, ce qui évoque un délai fixe.

**Course** (les deux postes enregistrent la même visite à des instants voisins, 12 tours) :
- 2 bifurcations (écarts NAS de 93 ms et 12 ms) ;
- 10 chaînes propres (écarts de 466 ms à 1,9 s) ;
- aucune bifurcation au-delà de 250 ms d'écart.

**Interprétation (hypothèse, non testée)** : le client SMB de Windows met en cache la liste d'un dossier (durée par défaut d'environ 10 s). Un poste qui relit sans cesse un dossier déjà listé voit une liste périmée. Un dossier non consulté depuis plusieurs secondes est vu à neuf. Les deux mesures sont compatibles avec cette hypothèse, mais elle n'a pas été confirmée par un test dédié (variation de l'intervalle de scrutation).

### 3.5 Interruptions et erreurs

- **Écriture interrompue** (onglet fermé en cours d'écriture) : laisse un fichier vide au nom définitif. Un bug de mon code a été corrigé : la version suivante réutilisait le même numéro. La règle retenue est que le numéro suivant s'appuie sur le plus haut numéro présent **dans les noms**, et que les fichiers illisibles sont ignorés. Reproduit et corrigé sur simulateur.
- **Erreur transitoire du navigateur** (« An operation that depends on state cached in an interface object… », `InvalidStateError` / `NotReadableError`) : survenue deux fois sur le poste A pendant que B écrivait dans le même dossier. L'appel exact n'a pas été identifié. `spike.html` rejoue désormais les listages et lectures concernés (4 essais) et nomme l'étape fautive dans le message. **Non revalidé sur le NAS réel.**
- **M6 (permission du dossier après redémarrage)** : poste A `granted`. Poste B : `prompt` au chargement d'une page. L'application doit donc gérer les deux cas (bouton de réautorisation).
- **Clé de test** : stockée par navigateur ; une clé différente d'un poste à l'autre donne « aucune version lisible » (empreintes a1af62c9 et b0336dd0 avant alignement). La distribution des vraies clés passera par le mécanisme prévu au Bloc 0 (Supabase, clé de secours hors ligne).

## 4. Décisions tirées

### 4.1 Stockage
Un fichier par version, ajout seul, jamais écrasé ni renommé ni supprimé par l'application.

### 4.2 Bifurcations
- La visibilité entre postes n'est pas garantie en dessous d'environ 10 s (hypothèse). La détection se fait **après coup**, pas à l'écriture :
  - à l'ouverture d'une visite ;
  - une fois, environ 12 s après chaque enregistrement.
- Une bifurcation est une modification parallèle faite sans connaissance de l'autre. Rien n'est perdu ; on rend les deux branches visibles et on les ordonne de façon déterministe.
- La résolution passe par une nouvelle version à **deux parents** (fusion), jamais par un renommage de fichier.
- Les parents sont désignés par l'**identité du fichier**, pas par un numéro (spécification : Bloc 2).
- Fréquence attendue : faible. Dans la course forcée, 2 conflits sur 12, tous à moins de 250 ms d'écart. Deux cliniciens qui enregistrent la même visite à la seconde près sont rares en usage réel.

### 4.3 Verrou
Un verrou en fichiers sur le NAS ne serait fiable qu'à environ 10 s près : **abandonné**. Une présence éphémère via Supabase (sans donnée patient) reste une option à étudier plus tard ; elle n'est pas nécessaire à l'exactitude des données.

### 4.4 Partitionnement
Lister `patients` à plat devient lent (3–7 s pour 1 446 patients, et pire au-delà). Un niveau de partitionnement est proposé dans la spécification.

## 5. Ce qui n'a pas été testé

- Edge (Chrome seul testé).
- Plus de deux postes simultanés.
- Heures de forte charge du NAS et sauvegardes en cours.
- Enregistrements de taille réelle (les fichiers de test sont des enregistrements fictifs de taille modeste).
- L'hypothèse du cache SMB (test d'intervalle de scrutation).
- Le comportement après une longue veille d'un poste (reprise d'un onglet ouvert, permission du dossier).
- Le test M6 depuis un environnement neuf pour le poste B.

## 6. Risques résiduels

| Risque | Gravité | Réponse prévue |
|---|---|---|
| Erreur transitoire non identifiée | moyenne | reprise automatique ; étape nommée ; revalider sur le NAS |
| Cache SMB variable selon la configuration du poste | moyenne | détection a posteriori indépendante du délai |
| Parcours complet très lent | faible à moyenne | pas de parcours interactif ; index dérivé au Bloc 5 |
| Noms de dossiers lisibles (IPP) hors chiffrement | à trancher | voir spécification, section des questions ouvertes |
| Perte de la clé | élevée | copie de secours hors ligne dès le premier jour (Bloc 0) |

## 7. Suite

Bloc 1bis (lecteur de secours) et Bloc 2 (spécification du format et des règles) : voir `BLOC2_specification.md`. Aucune donnée réelle avant avis du DPO.
