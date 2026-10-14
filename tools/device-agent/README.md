# Agent DSI — PC ONELA (lot 2 de la migration des postes)

`DsiAgent.ps1` est un fichier unique (PowerShell 5.1, intégré à Windows 10/11) qui :

1. **s'installe** quand on le lance depuis n'importe quel emplacement (script Intune, GPO, à la main) :
   copie dans `C:\ProgramData\DSI` (dossier réservé à SYSTEM + Administrateurs), tâche planifiée
   **« DSI Agent »** en SYSTEM (au démarrage + toutes les 30 min), premier rapport immédiat ;
2. **remonte l'état du PC** à la DSI App (`POST /api/device-agent/checkin`) à la cadence fixée par
   le serveur (4 h aujourd'hui).

**Lecture seule** : l'agent ne touche ni aux sessions, ni à la jonction AD / Entra, ni aux profils,
et n'exécute aucune commande reçue du serveur. Les utilisateurs continuent de se connecter avec
leur compte ONELA sans rien remarquer.

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

### 3. Intune ONELA (voie principale — tous les PC sont hybrides et inscrits)

Appareils > Windows > Scripts et corrections > **Scripts de plateforme** > Ajouter :

| Réglage | Valeur |
|---|---|
| Exécuter ce script avec les informations d'identification de l'utilisateur connecté | **Non** (SYSTEM) |
| Appliquer la vérification de la signature du script | Non |
| Exécuter le script dans un hôte PowerShell 64 bits | **Oui** |
| Affectation | groupe d'**appareils** (commencer par 2-3 PC de la DSI) |

Mise à jour : téléverser la nouvelle version du fichier ; Intune la ré-exécute, l'agent se réinstalle.

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
