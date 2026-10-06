# Première connexion Google — réglages pour supprimer les étapes manuelles

Objectif : le collaborateur clique sur « Me connecter à ma messagerie » dans le mail
d'identifiants (DSI App) et arrive dans Gmail, dans un profil Chrome pro, sans passer
par « Ajouter un profil Chrome ».

Parcours cible : **clic sur le bouton → mot de passe (+ nouveau mot de passe) → J'ai compris → Continuer → Gmail**.

> Toutes ces règles sont à appliquer d'abord sur une **UO de test**, avec un compte
> test `@mig.onela.com`, avant de les étendre à `/onela.com`.

---

## 1. Console d'administration Google — Chrome (le plus important)

Chemin : **Appareils → Chrome → Paramètres → Utilisateurs et navigateurs** (sélectionner l'UO).

| ☐ | Réglage | Valeur | Ce que ça supprime |
|---|---|---|---|
| ☐ | **Gestion de Chrome pour les utilisateurs connectés** | « Appliquer toutes les règles utilisateur lorsque les utilisateurs se connectent à Chrome » | **Prérequis** : sans ça, aucune des règles ci-dessous ne s'applique au profil |
| ☐ | **Séparation des profils** (`ProfileSeparationSettings`) | « Imposer la séparation des profils » | Étapes 1-3 : à la connexion web avec le compte pro, Chrome crée lui-même le profil séparé |
| ☐ | **Données de navigation existantes** (`ProfileSeparationDataMigrationSettings`) | « Ne pas importer les données dans le nouveau profil » | Évite qu'on demande à l'utilisateur s'il veut reprendre ses données perso |
| ☐ | **Moteur de recherche par défaut** | Activé, Google | Étape 4 (choix du moteur). ⚠ À vérifier : l'écran peut s'afficher avant que la règle arrive |
| ☐ | **Synchronisation Chrome** | Autoriser la synchronisation | Rend la synchro systématique (l'écran « Oui, j'accepte » peut rester) |
| ☐ | **Favoris gérés** | Gmail, Agenda, Drive, page d'aide DSI | Les collaborateurs ont leurs outils sous la main |
| ☐ | **Au démarrage** | Ouvrir `https://mail.google.com` | Chrome pro s'ouvre directement sur Gmail |
| ☐ | **Promotions / onglets de bienvenue** (`PromotionsEnabled`) | Désactivé | Moins d'écrans parasites |
| ☐ | **Invite Privacy Sandbox** (`PrivacySandboxPromptEnabled`) | Désactivé | Un écran de moins au premier lancement |

Les règles `ProfileSeparation*` ne se règlent **qu'au niveau du compte** (règle cloud
utilisateur) : c'est justement ce qu'il nous faut, car aucun déploiement n'est nécessaire sur les PC.

## 2. Console d'administration Google — Gmail

| ☐ | Réglage | Valeur | Ce que ça supprime |
|---|---|---|---|
| ☐ | **Données et confidentialité → Fonctionnalités intelligentes et personnalisation** | Valeur par défaut des utilisateurs : activé | Étapes 15-17 (3 écrans). ⚠ À vérifier : l'écran peut rester |
| ☐ | **Processus** : signatures et adresses « send-as » appliquées **la veille** du mail d'identifiants | — | Étape 18 (« Vos paramètres ont changé, Actualiser ») |

## 3. Entra ID (tenant GOH)

| ☐ | Réglage | Valeur | Ce que ça supprime |
|---|---|---|---|
| ☐ | **Personnalisation de l'entreprise → Formulaire de connexion → « Afficher l'option pour rester connecté »** | Non | Étape 8 (« Rester connecté ? ») |
| ☐ | *(décision à prendre)* Ne plus forcer le changement de mot de passe à la 1ʳᵉ connexion | — | Étape 7 (la plus difficile pour les utilisateurs). Compromis de sécurité |

## 4. Navigateur par défaut (point de vigilance)

Le bouton du mail s'ouvre dans le **navigateur par défaut**. Avec le nouvel Outlook,
c'est souvent **Edge** (réglage « Ouvrir les liens dans Microsoft Edge »). Dans ce cas,
aucun profil Chrome ne se crée. Le mail donne une solution de repli : « ouvrez Chrome et
allez sur mail.google.com ». La vraie correction consiste à définir Chrome comme navigateur par défaut via Intune,
si les PC sont gérés.

## 5. Protocole de test (≈ 30 min)

1. Créer une UO de test et y appliquer les réglages 1 à 3.
2. Sur un PC Windows standard (sans droits admin), Chrome déjà utilisé avec un profil perso.
3. S'envoyer le mail d'identifiants (variable `CREDENTIALS_TEST_RECIPIENT`) et l'ouvrir **dans Outlook comme les utilisateurs**.
4. Cliquer sur le bouton et noter **chaque écran affiché**, avec une capture.
5. Vérifier : profil séparé créé automatiquement ? moteur Google ? favoris présents ? Gmail ouvert ?
6. Recommencer en ouvrant le mail dans Outlook Web pour comparer le navigateur utilisé.

---

# Variante Intune : profil Chrome déployé sur le poste

Utilisée quand le lien du mail ne suffit pas (il s'ouvre dans Edge, ou le profil n'est pas créé).
Prérequis : PC Windows **inscrits dans Intune** et Chrome installé.

## A. Script de plateforme : raccourci « Messagerie ONELA » (un par région)

**Généré par la DSI App** : Migration → panneau Agences → ouvrir une région → bouton **« Script Intune Chrome »**.
Le fichier `chrome-profil-onela-<region>.ps1` contient la table **ancienne adresse ONELA (UPN + mail) → compte Google** de tous les
membres des groupes d'agence de la région :
- compte déjà migré : l'adresse `gohUpn` de la migration ;
- pas encore migré : l'adresse **prévue** `prenom.nom@mig.onela.com` (même règle que la migration). Il faut donc
  **regénérer le script après la migration** si un nom a été corrigé entre-temps.

Intune **ONELA** → **Appareils → Scripts et corrections → Scripts de plateforme → Ajouter → Windows 10 et versions ultérieures**

| Option | Valeur |
|---|---|
| Exécuter ce script avec les informations d'identification de l'utilisateur connecté | **Oui** (le raccourci est posé sur le bureau de l'utilisateur) |
| Appliquer la vérification de la signature du script | Non |
| Exécuter le script dans un hôte PowerShell 64 bits | Oui |
| Affectation | **Groupe d'utilisateurs** de la région (pas un groupe d'appareils) |

Le raccourci lance `chrome.exe --profile-directory="ONELA" --no-first-run` sur la connexion Google
(identifiant pré-rempli d'après l'utilisateur Windows : `whoami /upn`, à défaut l'identité Office), puis Gmail.
L'utilisateur absent de la table a quand même le raccourci, mais sans pré-remplissage. Aucun droit admin n'est nécessaire et aucun mot de passe n'est stocké dans le script.

Intune n'exécute le script qu'une fois par utilisateur. Pour le relancer (table mise à jour), il faut **remplacer le fichier** dans
le même script Intune : Intune considère alors qu'il a changé.
Journal sur le poste : `%LOCALAPPDATA%\ONELA\chrome-profil.log`.

## B. Stratégie Chrome (catalogue de paramètres)

Intune → **Appareils → Configuration → Créer → Windows 10 et versions ultérieures → Catalogue des paramètres**,
catégorie **Google → Google Chrome**. Affectation : groupe d'appareils ou d'utilisateurs du lot.

| ☐ | Paramètre | Valeur | Effet |
|---|---|---|---|
| ☐ | Activer le moteur de recherche par défaut | Activé | Appliqué **avant** la création du profil, ce qui supprime l'écran « Sélectionnez votre moteur de recherche » |
| ☐ | Nom du moteur de recherche par défaut | `Google` | |
| ☐ | URL de recherche du moteur par défaut | `https://www.google.com/search?q={searchTerms}` | |
| ☐ | URL de suggestion du moteur par défaut | `https://www.google.com/complete/search?client=chrome&q={searchTerms}` | |
| ☐ | Activer l'affichage de contenus promotionnels sur un onglet entier | Désactivé | Moins d'écrans au premier lancement |
| ☐ | Choisir d'afficher l'invite Privacy Sandbox | Désactivé | Un écran de moins |

Contrairement à la console Google, ces règles arrivent **sur la machine** avant que le profil existe : c'est ce qui permet de supprimer le choix du moteur.

## C. Point à vérifier au premier test

Avec la **séparation des profils imposée** dans la console Google (§1), Chrome pourrait vouloir
créer un *second* profil alors que l'utilisateur est déjà dans le profil « ONELA », qui est neuf.
Si c'est le cas, repasser la séparation des profils sur « Suggérer » pour l'UO concernée : le
profil séparé est désormais fourni par le raccourci.

## D. Parcours attendu

Double-clic sur « Messagerie ONELA » → identifiant (pré-rempli si la table est renseignée) → mot de passe
(+ nouveau mot de passe) → J'ai compris → « Ce profil sera géré » : Continuer → Gmail.
