# Agent DSI — PC ONELA (lot 2 de la migration des postes)

`DsiAgent.ps1` est un fichier unique (PowerShell 5.1, intégré à Windows 10/11) qui :

1. **s'installe** quand on le lance depuis n'importe quel emplacement (script Intune, GPO, à la main) :
   copie dans `C:\ProgramData\DSI` (dossier réservé à SYSTEM + Administrateurs), tâche planifiée
   **« DSI Agent »** en SYSTEM (au démarrage + toutes les 30 min), premier rapport immédiat ;
2. **remonte l'état du PC** à la DSI App (`POST /api/device-agent/checkin`) à la cadence fixée par
   le serveur (4 h aujourd'hui).

**Hors bascule, lecture seule** : l'agent ne touche ni aux sessions, ni à la jonction AD / Entra, ni
aux profils, et n'exécute jamais de commande reçue du serveur. Sa seule action possible est la
**bascule codée dans le script** (lot 3, ci-dessous), déclenchée uniquement si la DSI a programmé
ce poste précis dans la DSI App.

## Ce qui est remonté

Identité (MachineGuid, nom, n° de série, modèle), version de Windows, jonction AD + `dsregcmd /status`
(tenant, deviceId), inscription MDM et inscription automatique par GPO, client SCCM, TPM, Secure Boot,
environnement de récupération (WinRE, indispensable pour une réinstallation à distance), BitLocker,
réseau (Ethernet / Wi-Fi, SSID connecté, profils Wi-Fi enregistrés), disque, utilisateur connecté,
**profils Windows** (compte AD / Entra / local, dernière utilisation, données locales en Mo) et,
depuis l'agent 1.2.0, les **applications installées** (clés Uninstall HKLM 32 et 64 bits, hors
composants système et mises à jour, avec l'indication « désinstallation silencieuse possible »).
Elles alimentent le catalogue du bouton « Applications » de la DSI App : une décision par
application pour tout le parc, conservée ou désinstallée à la bascule en place.

Les données locales = Bureau + Documents + Téléchargements + dossiers `OneDrive*`, **fichiers
réellement présents sur le disque uniquement** (les fichiers OneDrive « en ligne uniquement » sont
ignorés). Mesure au plus une fois par 24 h, plafonnée à 4 min. Ces données seront **perdues** à la
bascule (décision DSI) : la liste sert à prévenir les utilisateurs concernés.

## Déploiement

### 1. Côté API

Variable d'environnement `DEVICE_AGENT_ENROLLMENT_KEY` (ex. `openssl rand -base64 32`). Sans elle,
l'endpoint répond 503.

### 2. Préparer le script

En tête de `DsiAgent.ps1`, renseigner `$ApiUrl` (URL de l'API, sans `/api`) et `$EnrollmentKey`
(même valeur que côté API).

Garder le fichier en **UTF-8 avec BOM** : sans BOM, Windows PowerShell 5.1 le lit en ANSI et un
seul caractère comme « — » dans une chaîne suffit à le rendre illisible (agent 1.0.4 : échec
Intune sans aucune trace dans `agent.log`). Avant chaque téléversement :

```bash
pwsh tools/device-agent/Test-AgentScript.ps1 ~/Desktop/DsiAgent-onela.ps1
```

### 3. Intune ONELA (voie principale — tous les PC sont hybrides et inscrits)

Appareils > Windows > Scripts et corrections > **Scripts de plateforme** > Ajouter :

| Réglage | Valeur |
|---|---|
| Exécuter ce script avec les informations d'identification de l'utilisateur connecté | **Non** (SYSTEM) |
| Appliquer la vérification de la signature du script | Non |
| Exécuter le script dans un hôte PowerShell 64 bits | **Oui** |
| Affectation | groupe d'**appareils** (commencer par 2-3 PC de la DSI) |

**Mise à jour sans toucher aux PC** : Propriétés du script > Paramètres du script > Modifier >
téléverser le nouveau fichier. Intune détecte que le contenu a changé et ré-exécute le script sur
chaque PC à son prochain contrôle (environ toutes les 8 h, et à chaque redémarrage) ; l'agent se
réinstalle alors par-dessus l'ancien en gardant son jeton. Il n'existe pas d'action à distance
qui force ce contrôle : la synchronisation Intune ne déclenche pas les scripts de plateforme.

**Suivi à distance (agent ≥ 1.0.4)** : l'installation envoie elle-même le 1er rapport. S'il échoue,
le script sort en erreur avec la cause (clé refusée, DSI App injoignable, 409…) : « État de
l'appareil » affiche **Échec**, et Intune relance le script jusqu'à 3 fois. Un « Réussi » garantit
donc que le PC est bien remonté dans la DSI App.

### 4. GPO ONELA (secours, pour un PC qui ne remonte pas d'Intune)

Stratégie ordinateur > Paramètres Windows > Scripts > **Démarrage** > PowerShell : `DsiAgent.ps1`.
⚠️ SYSVOL est lisible par tous les utilisateurs du domaine, donc la clé d'enrôlement aussi : filtrer
la GPO sur un groupe de PC et la retirer une fois les postes remontés.

### 5. Vérifier sur un PC

```powershell
Get-ScheduledTask -TaskName 'DSI Agent' | Get-ScheduledTaskInfo
Get-Content C:\ProgramData\DSI\agent.log -Tail 20
# Forcer un rapport (en administrateur) :
powershell -ExecutionPolicy Bypass -File C:\ProgramData\DSI\DsiAgent.ps1 -Force
```

Désinstaller : `powershell -ExecutionPolicy Bypass -File C:\ProgramData\DSI\DsiAgent.ps1 -Uninstall`

## Sécurité

- 1er check-in : clé d'enrôlement commune (**semi-publique** : elle est dans le script). Le serveur
  renvoie alors un **jeton propre au poste**, stocké dans `C:\ProgramData\DSI\token`. Côté DSI App,
  seul son hash SHA-256 est conservé.
- Un MachineGuid déjà enregistré ne peut pas se ré-enrôler (409) tant que la DSI n'a pas cliqué sur
  « Réinitialiser l'agent » dans la fiche du poste.
- Si la clé fuite, un tiers peut au pire déclarer de faux postes dans l'inventaire. **Le lot 3 ne
  devra jamais remettre le PPKG Ouihelp sur la seule foi de cette clé.**

## Bascule vers Ouihelp : mode « réinstallation propre » (agent ≥ 1.1.0, lot 3)

Pilote : PC **Entra Joined** uniquement. Deux modes au choix à la programmation :

- **Prévenir l'utilisateur** (défaut) : si une session est ouverte, l'agent affiche dans la session
  une fenêtre « Démarrer maintenant / Plus tard (15 min) » avec le message DSI. La bascule ne part
  que si l'utilisateur clique « Démarrer » (ou si personne n'est connecté). Jusqu'à **3 reports**,
  après quoi le bouton « Plus tard » disparaît et la DSI voit « reports épuisés » pour relancer.
- **Seulement hors session** : l'agent attend qu'aucune session ne soit ouverte.

1. **DSI App** : fiche du poste > « Programmer la réinstallation ». L'agent sonde la bascule toutes les 2 min (réaction quasi immédiate) ; l'inventaire complet reste espacé (~4 h).
2. **Agent** (statut *staging*) : dès la programmation, il neutralise la **mise en veille**, la
   mise en veille prolongée, l'extinction de l'écran et l'action de fermeture du capot (via
   `powercfg`) — session fermée, le PC resterait sinon sur l'écran de verrouillage et s'endormirait.
   Contrôles : aucune session ouverte, WinRE activé, secteur ou batterie ≥ 50 %.
   Il télécharge alors le PPKG Ouihelp (avec son jeton) et vérifie son SHA-256. Il exporte les Wi-Fi
   **clés comprises**, relève l'empreinte Autopilot, puis dépose dans `C:\Recovery\OEM` :
   - `ResetConfig.xml` : l'original du constructeur est sauvegardé en `.dsi-backup` ;
   - `DsiReset.cmd` ;
   - `DSI\`, qui contient le PPKG, les Wi-Fi, `FirstLogon.ps1`, `migration.json` et `unattend.xml`.
3. **Serveur** (*cleanup*) : retire le PC d'**Autopilot ONELA**, sinon un PC en Ethernet se
   réinscrirait chez ONELA à l'installation. Il supprime d'abord l'appareil Intune ONELA si Intune
   refuse.
4. **Agent** (*ready*) : `MDM_RemoteWipe.doWipeMethod`, équivalent de « Réinitialiser ce PC >
   Supprimer tout ».
5. **Réinitialisation**, étape `FactoryReset_AfterImageApply` : `DsiReset.cmd` copie `C:\DSI` et
   `Panther\unattend.xml` dans le nouveau Windows. Trace : `C:\DSI\reset.log`.
6. **Nouveau Windows** : l'`unattend.xml` crée en phase *specialize* une tâche SYSTEM « à
   l'ouverture de session ». La phase *oobeSystem* saute l'installation sans réseau, puis crée
   `dsi-secours` (mot de passe propre au poste, visible dans la DSI App) et l'ouvre une fois
   automatiquement. `FirstLogon.ps1` :
   - restaure les Wi-Fi ;
   - installe le PPKG et vérifie avec `dsregcmd` la jonction au tenant Ouihelp ;
   - enregistre la clé BitLocker chez Ouihelp, rend compte à la DSI App ;
   - **efface les secrets** (Wi-Fi, PPKG, unattend, autologon) puis redémarre.

   Trace : `C:\DSI\firstlogon.log`.
7. **Serveur** (*done*) : supprime les objets Intune et Entra ONELA, puis importe l'empreinte dans
   Autopilot Ouihelp avec l'étiquette **`OUIHELP`**, la même que le script de migration Intune
   (groupes dynamiques). Elle se change avec la variable `DEVICE_MIGRATION_GROUP_TAG`.

**Nom du poste chez Ouihelp** : `ONL-<site>-<fin du n° de série>`, par exemple `ONL-AIX-G255FX3`
pour une agence et `ONL-SIE-6HWLFH4` pour le siège ONELA, 15 caractères au maximum.
- Il est calculé par la DSI App, d'après le trigramme du nom actuel ou l'agence de l'utilisateur.
- Il est modifiable dans la fiche du poste, et figé à la programmation.
- Il est inscrit dans l'`unattend.xml`, puis réappliqué **après** l'installation du PPKG : **le nom
  saisi dans le PPKG est ignoré**, par exemple `ONL-%SERIAL%`, que l'assistant WCD impose.
- `FirstLogon.ps1` force aussi `AllowAddProvisioningPackage=1` avant d'installer le PPKG.

**À valider en pilote** (non testé sur un vrai PC) :
- que la réinitialisation déclenchée par le MDM exécute bien `ResetConfig.xml` ;
- que l'installation de Windows est bien sautée sans réseau ;
- que `Install-ProvisioningPackage` fonctionne en SYSTEM.

Si le poste reste sur l'installation de Windows, la fiche l'indique au bout de 3 h sans nouvelles :
intervention sur place.

**Permissions Graph en écriture** :
- ONELA : `DeviceManagementServiceConfig.ReadWrite.All`, `DeviceManagementManagedDevices.ReadWrite.All`,
  `Device.ReadWrite.All` ;
- Ouihelp : `DeviceManagementServiceConfig.ReadWrite.All`.

**PPKG** (Windows Configuration Designer > « Provisionner des appareils de bureau ») :
- nom `ONL-%SERIAL%` (imposé par l'assistant, ignoré ensuite), OOBE masqué ;
- **Inscrire dans Azure AD** avec un jeton en bloc obtenu avec un compte admin Ouihelp ;
- **pas de compte administrateur local** (l'agent crée `dsi-secours`), **pas de Wi-Fi** (ceux du
  poste sont restaurés).

Le PPKG se téléverse dans la DSI App, bouton « PPKG Ouihelp ».


## Bascule vers Ouihelp : mode « en place » (agent ≥ 1.2.0)

**Windows, les applications et les fichiers restent en place.** Le poste quitte ONELA, reçoit le
PPKG Ouihelp, et chaque profil Windows est donné au compte Ouihelp choisi par la DSI : l'utilisateur
se connecte avec son adresse Ouihelp et retrouve son bureau. Pilote : PC **Entra Joined ou
hybrides**. L'accord de l'utilisateur et les reports fonctionnent comme en réinstallation propre.

Méthode reprise d'**IntuneMigration V9** (Steve Weiner), avec quatre différences :

| V9 | Ici |
|---|---|
| L'utilisateur se connecte à Ouihelp pendant la bascule (`Connect-AzAccount`, `Az.Accounts`, session interactive obligatoire) pour donner son SID | Les SID Ouihelp sont lus par le **serveur** dans Graph et transmis dans l'ordre (`profileMap`) : aucune action de l'utilisateur, la bascule marche aussi hors session |
| `config.json` avec les **secrets client Graph des deux tenants** déposé sur chaque PC | **Aucun secret Graph sur le poste** : tout ce qui touche aux tenants est fait par le serveur |
| Ouverture de session automatique avec un mot de passe **en clair** dans `Winlogon\DefaultPassword` | Aucun autologon : l'agent survit à la bascule et enchaîne les étapes en SYSTEM à chaque réveil (2 min) |
| Avancement dans un journal local | Chaque étape est **rendue à la DSI App** et reprise au passage suivant en cas d'échec ou de redémarrage |

### Déroulé

1. **DSI App** : fiche du poste > mode « En place » > « Programmer la bascule ». Le tableau des
   profils montre ce que devient chaque profil ONELA du poste :
   - **un seul profil est conservé** et transféré, par défaut celui du **dernier utilisateur
     connecté** ; la DSI peut en désigner un autre (« Conserver celui-ci »). Son compte Ouihelp est
     trouvé par la table des migrations de comptes, puis par l'adresse mail, ou saisi à la main ;
     sans correspondance, la programmation est refusée ;
   - **tous les autres profils ONELA sont supprimés du poste** à la bascule : clé
     `ProfileList` et dossier de `C:\Users`, données locales comprises. Leurs comptes ONELA ne
     peuvent de toute façon plus ouvrir de session une fois le poste sorti du tenant.
   - les profils de comptes **locaux** (compte de secours, administrateur local) ne sont jamais
     touchés.
2. **Agent** (*staging*) : neutralise la mise en veille, contrôle l'alimentation et **10 Go libres**,
   télécharge le PPKG et vérifie son SHA-256, puis fige l'ordre dans
   `C:\ProgramData\DSI\migration\inplace.json` (**sans aucun secret** : le mot de passe du compte
   de secours n'est jamais écrit sur le disque). Rien de destructif à ce stade : annulation possible.
3. **Serveur** (*cleanup* → *ready*) : retire le poste d'Autopilot ONELA.
4. **Agent** (*resetting* = « bascule en cours sur le poste ») — **point de non-retour** :
   - crée le compte local d'administration `dsi-secours` (mot de passe visible dans la DSI App,
     bouton « Compte de secours ») : c'est le seul moyen d'ouvrir une session avant la jonction ;
   - désinstalle les applications décochées dans le catalogue, avec la commande enregistrée
     localement (MSI ou `QuietUninstallString`), et rend compte de chacune ;
   - retire l'inscription Intune ONELA (certificat, clés `Enrollments`, tâches de synchronisation) ;
   - `dsregcmd /leave`, puis sortie du domaine avec le compte de secours si le PC est hybride ;
   - installe le PPKG Ouihelp (repli `dism.exe` si `Install-ProvisioningPackage` échoue) ;
   - redémarre. Message d'attente sur l'écran de verrouillage pendant les deux redémarrages.
5. **Agent** (phase « profils », session fermée) : retrait des jetons de l'ancien tenant
   (`AAD.BrokerPlugin`), enregistrement du compte Ouihelp (`CreateProfile`, profil créé puis
   supprimé), puis **`Win32_UserProfile.ChangeOwner`** vers le SID Ouihelp et nettoyage des caches
   d'identité qui pointent encore sur l'ancien UPN. **Une fois le transfert réussi**, les autres
   profils ONELA sont supprimés (`Remove-CimInstance` sur `Win32_UserProfile`, qui retire la clé de
   registre et le dossier ; reliquats nettoyés derrière). Puis redémarrage.
6. **Agent** (phase « jonction ») : attend la jonction au tenant Ouihelp (`dsregcmd`), enregistre la
   clé BitLocker chez Ouihelp, applique le nom DSI **après** le PPKG, rend compte « joint » et
   retire ses fichiers de bascule.
7. **Serveur** (*done*) : supprime les objets Intune et Entra ONELA, importe l'empreinte dans
   Autopilot Ouihelp (étiquette `OUIHELP`) et définit l'**utilisateur principal** de l'appareil dans
   Intune Ouihelp — l'inscription par jeton en bloc n'en désigne aucun.

### Garde-fous

- L'agent **n'exécute jamais une commande venue du serveur** : le serveur ne transmet que des noms
  d'applications, des SID et des UPN. La désinstallation utilise la commande enregistrée par
  l'installeur sur le poste.
- Au-delà de 3 tentatives sur la bascule, 5 sur les profils et 20 sur la jonction, l'agent s'arrête
  en rendant compte au lieu de retenter toutes les 2 min, et retire son message d'attente.
- **Passé le point de non-retour, l'agent termine le travail local même si la DSI « abandonne » la
  bascule dans l'app** : sinon le poste resterait entre les deux tenants. L'abandon le dit.
- Si le transfert du profil conservé échoue, **aucun profil n'est supprimé** : l'agent réessaie au
  passage suivant.
- L'agent ne supprime jamais un profil **système, chargé (session ouverte), local**, ni celui qui
  fait partie du transfert, quoi que dise l'ordre reçu.
- Le jeton de jonction en bloc du PPKG expire (180 jours au plus). La DSI App **refuse de programmer**
  une bascule avec un PPKG expiré, et signale celui qui expire dans moins de 30 jours.

### Ce que la bascule en place ne fait pas

- Les données déjà dans OneDrive ONELA ne suivent pas : c'est un compte, pas un fichier local.
- Les données locales des profils supprimés sont **perdues** (décision DSI) : la colonne « Données
  locales » du tableau dit combien il y en a, avant de programmer.
- L'appartenance aux groupes locaux, les applications installées par utilisateur (`AppData`) et les
  réglages liés au SID d'origine peuvent demander une reprise ponctuelle.
- Le profil n'est transféré qu'une fois : relancer une bascule sur un poste déjà basculé n'a pas
  de sens, la DSI App l'empêche tant qu'une bascule est en cours.

**À valider en pilote** (non testé sur un vrai PC) : `ChangeOwner` sur un profil hybride, la sortie
du domaine avec le compte local de secours, et la jonction par PPKG juste après le `dsregcmd /leave`.
