# Visites Neuro v3 : Bloc 0, décisions de cadrage

Statut : brouillon à relire et corriger avant tout code. Date de rédaction : 2026-10-27.
Ce document fixe les décisions, les hypothèses à tester et ce qui est volontairement hors périmètre. Il remplace la logique de la version v2 (SQLite unique chiffré + verrous), qui devient une référence d'ergonomie et de logique métier, pas une base à réparer.

\---

## 1\. Objet et usage

* Orbis reste l'outil institutionnel obligatoire et la source de vérité légale.
* Cet outil est un **accélérateur de compte-rendu (CR)** : saisie structurée choisie par le clinicien → CR généré → copie manuelle dans Orbis.
* La base de données est un **sous-produit** de la saisie : elle sera forcément « trouée », et c'est acceptable. Une valeur absente = donnée manquante pour cette visite.
* Sens Orbis → base (ex. biologie) : plus tard, hors périmètre actuel.
* Règle de conception : ne structurer que ce que le CR utilise ; les champs purement « recherche » viennent d'un mode ou de filtres dédiés. Si la saisie structurée est plus lente que taper le CR dans Orbis, personne ne l'utilisera.

## 2\. Contraintes dures et menace visée

|Contrainte|Décision|
|-|-|
|Hébergement des données|Locales, sur le NAS du service (acceptable), chiffrées|
|Infrastructure|Aucune (pas de serveur, la DSI ne le permet pas)|
|Code|Public sur GitHub (GitHub Pages), sans donnée sensible|
|Supabase|Authentification, clés, définitions de tests et gabarits partagés. Aucune donnée patient|
|Navigateurs|Chrome et Edge (API File System Access)|
|Volume|Jusqu'à \~100 visites/jour, usage à long terme (≈ 36 000 visites/an, plusieurs versions chacune)|

**Menace visée par le chiffrement** : copie du fichier hors du NAS (clé USB, sauvegarde mal gardée, envoi par erreur). Ce n'est **pas** une protection contre un collègue authentifié sur le NAS ni contre une usurpation de session Windows (risque de niveau supérieur, qui compromet aussi Orbis).

**Pseudonymisation** : les données sont pseudonymisées (IPP, date de naissance, initiales nom/prénom), pas anonymes.  L'IPP seul n'est ré-identifiant que via Orbis. Le cadre réglementaire de la réutilisation pour la recherche n'est pas traité ici.

## 3\. Modèle de données

Trois niveaux :

* **Patient** : identifié par l'IPP.
* **Épisode** : regroupe des visites (une hospitalisation, un séjour).
* **Visite** : un moment de saisie (date, heure, type). C'est l'unité de version et de verrou.

Règles :

* `episode\_id` et `visite\_id` sont des **UUID opaques** générés côté client, sans date ni type dedans.
* **Toute visite a un `episode\_id`**. Il est créé automatiquement pour les événements uniques.

  * `consultation`, `HDJ` : épisode d'une seule visite.
  * `HC`, `HDS`, `USINV`, `UNV` : épisode multi-visites (évolution quotidienne + CR de sortie).
  * `avis`, `recherche` : à trancher (voir §13).
* Le doublon « même IPP + même date + même type » est un **avertissement à l'écran**, jamais une clé.
* Les items répétés (ex. plusieurs MMSE) sont comparés au sein d'un épisode. Les gabarits de CR sauront un jour parler de « première », « dernière », « évolution » d'une valeur.
* Une visite stocke uniquement les **items renseignés** : `{item\_id: valeur}`. Clé absente = donnée manquante (jamais 0 par défaut).
* Les totaux (champs calculés) sont **recalculés à l'affichage**, jamais stockés, avec la mention « partiel (n/N items) » quand il en manque.

### Identité

* À l'ouverture d'une visite, l'outil affiche la date de naissance et les initiales connues pour l'IPP saisi et demande confirmation. S'il n'en connaît pas, il les enregistre.
* Chaque visite porte IPP, date de naissance et initiales, pour permettre un contrôle de cohérence a posteriori.

## 4\. Stockage : un fichier par version, en ajout seul

Arborescence :

```
<racine NAS>/patients/<IPP>/<visite\_id>/v0007\_<auteur>\_<horodatage>\_<aleatoire>.enc
```

* Un fichier = une version complète d'une visite. **Jamais d'écrasement, jamais de modification d'un fichier existant.**
* `v0007` : numéro de version de la visite. `<aleatoire>` : court suffixe aléatoire pour garantir l'unicité même avec deux onglets du même utilisateur.
* L'IPP figure dans le dossier parent et dans le contenu chiffré, **pas dans le nom du fichier** (une correction d'IPP ne doit pas obliger à renommer).
* La version courante d'une visite = la version la plus élevée valide.
* Un fichier tronqué (coupure réseau) échoue au déchiffrement AES-GCM : il est ignoré et on retombe sur la version précédente.
* Une seule autorisation d'accès au dossier racine (pas fichier par fichier), à valider dans le spike.

### Pierre tombale et corrections

* Annuler une visite = nouvelle version « annulée » avec **motif obligatoire**, auteur et date. Rien n'est supprimé.
* **Correction d'IPP** : pierre tombale dans l'ancien dossier avec pointeur vers le nouvel IPP ; nouvelle version dans le bon dossier avec pointeur arrière. Audit possible dans les deux sens.
* **Effacement réel** (droit d'un patient) : procédure d'administration distincte, hors fonctionnement normal, à prévoir dans le format.

### Index local (cache)

* Les requêtes transversales (tri, filtres, étude) utilisent un **index local par poste** (IndexedDB), **cache reconstructible**, jamais source de vérité.
* Purgeable : à la déconnexion, après N jours sans synchronisation, ou par bouton « vider le cache local ». Le code sait toujours le reconstruire.
* IndexedDB étant lié à l'origine, préfixer les noms de bases et idéalement isoler cet outil sur sa propre origine.
* Autorisé : données pseudonymisées en IndexedDB sur les postes (session Windows nominative).
* Pas d'index partagé dans un fichier (réintroduirait la concurrence).
* Pour une étude : export complet reconstruisant une base SQLite ou un CSV sur une machine. SQLite devient une **projection pour l'analyse**, plus le stockage de référence.

## 5\. Concurrence

Trois cas distincts :

1. **Deux utilisateurs, visites différentes** : aucun conflit possible (fichiers différents).
2. **Deux visites du même patient** : idem.
3. **Deux personnes éditent la même visite** : seul vrai conflit.

Règles retenues :

* **Tout utilisateur peut modifier toute visite**, avec historique complet des versions (auteur, date).
* **Garantie** : versions en ajout seul. Si deux versions portent le même numéro, c'est une **bifurcation** : détectée, signalée à l'écran, résolue par l'utilisateur (pas de fusion automatique pour l'instant).
* **Confort** : verrou « visite en cours de modification par XX », lecture seule pour les autres. Le verrou n'est qu'une bonne volonté (il peut expirer), il réduit les bifurcations mais n'en est pas la protection.
* Fusion automatique (A modifie le MMSE, B le LDL) : possible plus tard car les versions ne contiennent que les items renseignés.

## 6\. Chiffrement et clés

* Chiffrement AES-256-GCM (WebCrypto). Chaque fichier est chiffré avec une **clé de données (DEK)** distincte de la clé d'accès.
* En-tête de chaque fichier : `format\_version`, `key\_id`, IV, puis le contenu chiffré.
* La DEK est stockée « enveloppée ». Prototype : **une enveloppe sur Supabase** (usage courant, protégée par RLS).
* **Copie hors ligne de la DEK faite dès le premier jour**, jamais sur le NAS ni sur un support que la même panne peut détruire.
* **Test de restauration réalisé une fois** : déchiffrer un fichier avec la seule copie de secours, Supabase coupé.
* Supabase : activer les sauvegardes, vérifier la politique de suspension pour inactivité, prévoir un second compte propriétaire, vérifier les règles RLS de la table des clés **avant tout** (la clé « publishable » est publique).
* **Cible future** : enveloppes individuelles par superadmin (paire de clés personnelle, p. ex. RSA-OAEP). Chacun peut tout débloquer seul ; retirer un superadmin = supprimer son enveloppe. Limite : retirer quelqu'un n'invalide pas ce qu'il a déjà copié sans rotation complète (rechiffrement progressif possible via `key\_id`). Gestion des superadmins hors prototype, format déjà compatible.
* Le chiffrement ne protège pas contre un accès interne autorisé (voir §2).

## 7\. Lecteur de secours (bloc dédié, avant le reste de l'interface)

Choisir des JSON chiffrés déplace la fiabilité vers le code de lecture. Pour la garantir :

* **Spécification écrite du format** (en-tête, algorithme, structure du JSON) : une personne extérieure doit pouvoir réécrire un lecteur à partir d'elle. C'est la vraie garantie.
* **Utilitaire autonome** (un seul fichier HTML, avec `vendor/` si besoin) : déchiffrement → reconstruction des versions courantes → export CSV/JSON. Sans dépendance à Supabase ni à l'interface principale.
* Copie de l'utilitaire sur le NAS à côté des données, versionnée par une **release GitHub étiquetée** (ex. `lecteur-v1.0`).
* **Fichiers de test figés** : quelques fichiers chiffrés d'exemple avec leur CSV attendu, vérifiés à chaque modification du lecteur.
* Le lecteur sait lire **toutes les versions de format** passées.
* Ce lecteur est aussi le moteur de l'index et de l'export pour les études.

## 8\. Sécurité du code

* **Aucun script chargé depuis un CDN.** Les bibliothèques (supabase-js, sql.js si conservé pour l'export) sont **copiées dans `vendor/` du dépôt**, à version exacte. Mise à jour volontaire et consignée, après lecture de ce qui a changé.
* Raison : un script tiers s'exécute avec les mêmes droits que l'application (clé en mémoire, données déchiffrées, dossier NAS autorisé).
* Échapper systématiquement tout texte injecté en HTML (libellés issus de CSV, saisie libre).
* `sql.js` n'est chargé que pour l'export si SQLite n'est plus au cœur du stockage.

## 9\. Définitions de tests et gabarits de CR

* Les définitions de tests sont **partagées sur Supabase**, avec des **identifiants d'item stables** (jamais dérivés des libellés) et un **versionnement** : chaque visite référence `test@version`.
* **Copie des définitions utilisées sur le NAS**, pour qu'une visite ancienne reste interprétable si Supabase disparaît ou si un test change.
* Gouvernance : un propriétaire par test, un statut « validé ». Éviter que chacun crée « son MMSE » avec des items différents.
* Les gabarits de CR sont aussi partagés. Plus tard : conditionnelles, notions d'évolution (première/dernière valeur).

### Sécurité clinique du CR

* Une valeur manquante ne s'écrit jamais `NAN` en clair dans un texte destiné à Orbis : marqueur impossible à manquer (surbrillance, copie bloquée tant que des champs ne sont pas relus).
* Mention explicite « brouillon à relire ».

## 10\. Filtres de saisie (protocoles)

* Chaque utilisateur choisit ce qu'il remplit au quotidien via des filtres/protocoles (ex. protocole HD, protocole AVC).
* Un item peut toujours être rempli hors du protocole actif (ex. LDL chez un patient HD).
* À noter pour toute étude : les manquants ne sont pas « au hasard » (le LDL n'est saisi que lorsque le clinicien l'a jugé pertinent). Cela relève de la méthodologie de l'étude, pas de l'outil.

## 11\. Critère de réussite du prototype

> Un clinicien saisit un patient HD en consultation, avec les items qu'il choisit, et obtient un CR copiable en \*\*moins de 3 minutes\*\*, sans manipulation de fichier.

## 12\. Feuille de route

|Bloc|Contenu|Critère de sortie|
|-|-|-|
|**0**|Ce document, relu et corrigé|Décisions validées|
|**1**|**Spike jetable** sur le vrai NAS, depuis 2 postes, \~5 000 **fausses** visites|Mesures ci-dessous, décision go/no-go sur l'architecture|
|**1bis**|**Lecteur de secours** : spécification du format, utilitaire d'export, fichiers de test figés, test de restauration de clé|Un fichier écrit est relu et exporté sans l'interface|
|**2**|Spécification finale du format et modèle des tests (item\_id stables, `test@version`, calculs recalculés, manquants)|Spécification relue|
|**3**|Saisie minimale de bout en bout : IPP, vérification d'identité, un test, sauvegarde versionnée|Une visite créée, relue, modifiée avec historique|
|**4**|Génération de CR|Critère de réussite du §11|
|**5**|Le reste : CIM-10, antécédents, protocoles, épisodes multi-visites complets, export pour étude, gestion des superadmins|À planifier|

### Mesures du spike (bloc 1)

1. Latence : lister le dossier d'un patient et lire sa dernière version.
2. Durée d'un scan complet pour reconstruire l'index (comparer avec/sans journal de synchronisation si le listing est trop lent).
3. Écritures simultanées dans des fichiers différents : aucun incident.
4. Écritures simultanées de la même version : la bifurcation est détectée.
5. Coupure en pleine écriture : fichier tronqué rejeté, version précédente reprise.
6. Persistance de la permission sur le dossier racine entre les sessions.
7. Temps de reconstruction de l'index depuis zéro (purge du cache).

### Tests automatiques minimaux (dès le début, stockage et chiffrement uniquement)

* Aller-retour chiffrement/déchiffrement identique à l'original.
* Fichier altéré ou tronqué : échec franc, jamais de données fausses.
* Mauvaise clé : échec net.
* Écriture en ajout seul : une nouvelle version ne modifie jamais une ancienne.
* Bifurcation : deux versions de même numéro détectées.
* Reconstruction de la version courante depuis un dossier de versions mélangées.
* Forme : un fichier `tests.html` (ou Node) affichant vert/rouge, sans outil de build.

## 13\. Questions ouvertes

1. `avis` et `recherche` : épisode d'une seule visite, ou rattachables à un épisode existant ?
2. Journal de synchronisation (un petit journal par session et par jour pour savoir ce qui a changé) : à n'implémenter que si le spike montre que le simple listing est trop lent. Ne pas dépendre de l'ordre de listage du NAS et garder l'horodatage dans chaque version.
3. Avis écrit du DPO sur l'outil (registre de traitement, pseudonymisation, stockage de l'index local) avant toute utilisation sur de vraies données.
4. Qui sauvegarde le NAS ? La sauvegarde ne doit pas contenir la clé. L'ajout seul protège des erreurs de saisie, pas d'un chiffrement par ransomware.
5. Données réelles existantes issues de l'ancienne version (`.db`) à migrer ? Cela pèse sur le bloc 2.
6. Date de naissance complète nécessaire, ou l'âge à la visite suffit-il ? (Moins de champs identifiants = moins à défendre.)
7. Dépendance à internet (GitHub Pages + authentification Supabase) pour la saisie : acceptée explicitement ?
8. Détenteurs des clés de secours individuelles (superadmins) et procédure en cas de départ.

## 14\. Hors périmètre volontaire (à reprendre plus tard)

* Archivage local automatique de tous les outils GitHub/Supabase (sujet à part).
* Fusion automatique des bifurcations.
* Retour Orbis → base.
* Gestion fine des enveloppes superadmin et rotation des clés.
* Cadre réglementaire de la recherche sur la base.

## 15\. Règles de travail

* Toute la phase de prototype se fait sur de **fausses données**, y compris le spike sur le NAS (fichiers générés par script).
* Avancer par blocs, en construisant d'abord ce qui est le plus risqué (stockage, concurrence, lecture), pas ce qui est le plus visible.
* Le développeur garde la main sur le code : les modifications sont proposées sous forme d'instructions localisées.

