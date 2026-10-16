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
**profils Windows** (compte AD / Entra / local, dernière utilisation, données locales en Mo).

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

## Bascule vers Ouihelp : réinstallation propre (agent ≥ 1.1.0, lot 3)

Pilote : PC **Entra Joined** uniquement. Deux modes au choix à la programmation :

- **Prévenir l'utilisateur** (défaut) : si une session est ouverte, l'agent affiche dans la session
  une fenêtre « Démarrer maintenant / Plus tard (15 min) » avec le message DSI. La bascule ne part
  que si l'utilisateur clique « Démarrer » (ou si personne n'est connecté). Jusqu'à **3 reports**,
  après quoi le bouton « Plus tard » disparaît et la DSI voit « reports épuisés » pour relancer.
- **Seulement hors session** : l'agent attend qu'aucune session ne soit ouverte.

1. **DSI App** : fiche du poste > « Programmer la réinstallation ». L'agent repasse toutes les 15 min.
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
