# Givernance — Custom Keycloak image
#
# Extends the official Keycloak image with the Givernance login theme so that
# the realm's `loginTheme: "givernance"` resolves in all environments.
#
# Why a custom image instead of a bind-mount?
# Kamal accessories support single-file mounts (files:) but not directory-tree
# mounts, so infra/keycloak/themes/ cannot be mounted directly via Kamal config.
# Building a custom image is the standard Keycloak approach for theme distribution
# and avoids runtime filesystem dependencies on the host.
#
# Image is built and pushed to GHCR in the deploy-staging.yml workflow before
# `kamal accessory boot keycloak` runs.
FROM quay.io/keycloak/keycloak:26.6.1

# Copy the Givernance login theme. Keycloak discovers themes by scanning
# /opt/keycloak/themes/ on startup.
COPY themes/givernance /opt/keycloak/themes/givernance
