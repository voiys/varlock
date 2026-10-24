---
"@varlock/1password-plugin": patch
"@varlock/akeyless-plugin": patch
"@varlock/aws-secrets-plugin": patch
"@varlock/aws-sigv4-plugin": patch
"@varlock/azure-key-vault-plugin": patch
"@varlock/bitwarden-plugin": patch
"@varlock/dashlane-plugin": patch
"@varlock/doppler-plugin": patch
"@varlock/effect-plugin": patch
"@varlock/google-secret-manager-plugin": patch
"@varlock/hashicorp-vault-plugin": patch
"@varlock/infisical-plugin": patch
"@varlock/keepass-plugin": patch
"@varlock/keeper-plugin": patch
"@varlock/kubernetes-plugin": patch
"@varlock/pass-plugin": patch
"@varlock/passbolt-plugin": patch
"@varlock/proton-pass-plugin": patch
---

Ship a plugin manifest, with validation rules for its data types, so tools using varlock shape mode can read the plugin without running it. The Akeyless plugin now reports its own message for an invalid `akeylessAccessId` instead of "Unexpected error during validation".
