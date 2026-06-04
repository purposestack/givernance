<#--
  Givernance — Keycloak Login Theme — template.ftl
  ============================================================
  Main layout macro used by every login page in this theme.
  Supports per-org branding via Keycloak 26 Organization attributes:
    - theme_primary_color  : hex color for primary actions (default: #08675b)
    - logo_url             : public URL of the org logo (optional)
  Both are non-sensitive public values and safe to store in Organization
  attributes (see CLAUDE.md — "No secrets in Keycloak Organization attributes").

  Pattern 1 (subdomain-first): the app passes kc_org=<alias> derived from the
  Host header, which resolves the Organization and populates ${organization}.
-->
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>

<#-- Resolve per-org branding from Organization attributes (KC 26). -->
<#assign gvPrimary    = "#08675b">
<#assign gvOrgLogoUrl = "">
<#assign gvOrgName    = (realm.displayName)!"Givernance">
<#if organization??>
  <#if (organization.attributes['theme_primary_color']![])?has_content>
    <#assign rawColor = organization.attributes['theme_primary_color']?first>
    <#-- C1: Validate against ^#[0-9a-fA-F]{6}$ to prevent CSS injection via
         a malformed or adversarial Organization attribute. Fall back to the
         default brand green if the value does not match. -->
    <#if rawColor?matches("^#[0-9a-fA-F]{6}$")>
      <#assign gvPrimary = rawColor>
    </#if>
  </#if>
  <#-- The `logo_url` Organization attribute is populated by the worker job
       `packages/worker/src/processors/keycloak-sync-org-logo.ts` (Epic #286).
       Source of truth: app-DB `tenants.logo_asset_id` → `org_branding_assets`
       → `s3_key_variants['public-hero']` URL. The sync is async via the
       outbox-relay (see `docs/24-branding-assets.md` § 4.4 and
       `docs/05-integration-migration.md` § 5.1). Sub-second drift on the
       relay is accepted as benign for a non-transactional surface. -->
  <#if (organization.attributes['logo_url']![])?has_content>
    <#assign gvOrgLogoUrl = organization.attributes['logo_url']?first>
  </#if>
  <#if organization.name?has_content>
    <#assign gvOrgName = organization.name>
  </#if>
</#if>
<#-- M6: Compute hover color via CSS color-mix so per-org primary colors
     darken correctly without a server-side color-math library. -->
<#assign gvPrimaryHover = "color-mix(in srgb, " + gvPrimary + " 85%, black)">

<#-- locale is null when internationalizationEnabled=false in the realm,
     or in certain non-interactive Keycloak flows. Guard every access. -->
<#assign currentLang = "en">
<#if locale??><#assign currentLang = locale.currentLanguageTag!"en"></#if>

<!DOCTYPE html>
<html lang="${currentLang}" dir="ltr">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${msg("loginTitle", gvOrgName)}</title>
  <link rel="icon" href="${url.resourcesPath}/img/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${url.resourcesPath}/css/givernance.css">
  <#-- Per-org CSS custom property overrides -->
  <style>
    :root {
      --gv-primary:       ${gvPrimary};
      --gv-primary-hover: ${gvPrimaryHover};
      --gv-primary-ring:  color-mix(in srgb, ${gvPrimary} 25%, transparent);
    }
  </style>
</head>
<body>
<#-- Decorative full-viewport icon-rain background. Self-hosted JS (no
     external requests) so the Keycloak login matches the SPA login page
     while remaining GDPR-compliant (LG München ruling on third-party
     scripts/fonts). aria-hidden + tabindex=-1 keep it out of AT trees and
     focus order. -->
<canvas id="gv-auth-bg" class="gv-bg-canvas" aria-hidden="true" tabindex="-1"></canvas>
<script src="${url.resourcesPath}/js/auth-background.js"></script>

<div class="gv-auth-page">
  <div class="gv-auth-card">

    <#-- Logo / brand -->
    <div class="gv-auth-header">
      <#-- M1: Only render the logo when the URL starts with https:// to prevent
           loading from arbitrary origins. Add referrerpolicy + crossorigin to
           avoid leaking the Keycloak auth URL to the logo's origin server.
           DEV NOTE: in local dev the branding bucket is served from
           `http://localhost:9000/branding/...` — the HTTPS guard fails
           closed and the org logo simply doesn't render on the dev
           Keycloak login screen. This is intentional; production uses
           Scaleway Object Storage over HTTPS so the guard passes. -->

      <#if gvOrgLogoUrl?has_content && gvOrgLogoUrl?starts_with("https://")>
        <img src="${gvOrgLogoUrl}" alt="${gvOrgName}" class="gv-org-logo"
             referrerpolicy="no-referrer" crossorigin="anonymous">
        <p class="gv-org-name">${gvOrgName}</p>
      <#else>
        <div class="gv-brand-logo">
          <svg viewBox="0 0 500 500" fill="none" xmlns="http://www.w3.org/2000/svg"
               class="gv-logo-svg" aria-hidden="true" focusable="false">
            <g transform="matrix(1.000819,0,0,1.000819,0.018136,-0.082685)">
              <path fill="#008570" d="M440,162.652L440,349.573C440,356.022 436.55,361.979 430.955,365.187L362.648,404.364C357.101,407.545 350.284,407.545 344.737,404.364L276.429,365.187C270.835,361.979 267.385,356.022 267.385,349.573L267.385,271.461C267.385,264.993 270.854,259.023 276.474,255.821L372.692,201L372.692,200.782L440,162.652Z"/>
              <path fill="#ec6a66" d="M372.692,200.782L372.692,101L422.049,129.598C433.16,136.036 440,147.906 440,160.747L440,162.652L372.692,200.782Z"/>
            </g>
            <g transform="matrix(-0.495948,-0.859007,0.859007,-0.495948,158.15141,586.415061)">
              <path fill="#008570" d="M440,162.652L440,349.573C440,356.022 436.55,361.979 430.955,365.187L362.648,404.364C357.101,407.545 350.284,407.545 344.737,404.364L276.429,365.187C270.835,361.979 267.385,356.022 267.385,349.573L267.385,271.461C267.385,264.993 270.854,259.023 276.474,255.821L372.692,201L372.692,200.782L440,162.652Z"/>
              <path fill="#ec6a66" d="M372.692,200.782L372.692,101L422.049,129.598C433.16,136.036 440,147.906 440,160.747L440,162.652L372.692,200.782Z"/>
            </g>
            <g transform="matrix(-0.500409,0.866734,-0.866734,-0.500409,592.049884,158.497743)">
              <path fill="#008570" d="M440,162.652L440,349.573C440,356.022 436.55,361.979 430.955,365.187L362.648,404.364C357.101,407.545 350.284,407.545 344.737,404.364L276.429,365.187C270.835,361.979 267.385,356.022 267.385,349.573L267.385,271.461C267.385,264.993 270.854,259.023 276.474,255.821L372.692,201L372.692,200.782L440,162.652Z"/>
              <path fill="#ec6a66" d="M372.692,200.782L372.692,101L422.049,129.598C433.16,136.036 440,147.906 440,160.747L440,162.652L372.692,200.782Z"/>
            </g>
          </svg>
          <span class="gv-brand-name">Givernance</span>
        </div>
        <#if organization?? && gvOrgName != "Givernance">
          <p class="gv-org-name">${gvOrgName}</p>
        </#if>
      </#if>
    </div>

    <#-- Page title -->
    <h1 class="gv-auth-title"><#nested "header"></h1>

    <#-- Flash message -->
    <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
      <div class="gv-message gv-message--${message.type}" role="alert">
        ${kcSanitize(message.summary)?no_esc}
      </div>
    </#if>

    <#-- Main content (form) -->
    <#nested "form">

    <#-- Secondary info (social providers, registration link, etc.) -->
    <#if displayInfo>
      <div class="gv-auth-info">
        <#nested "info">
      </div>
    </#if>

  </div>

  <#-- M8: Locale picker for direct KC flows (password-reset email links, etc.)
       where the app's /login page — which normally drives the language via
       kc_locale — is bypassed. The picker is also shown on the main login page
       when the app controls the locale; the JS auto-switch below takes care of
       applying the requested kc_locale before the picker is visible. -->
  <#if locale?? && locale.supported?? && (locale.supported?size > 1)>
    <div class="gv-locale-picker">
      <select class="gv-locale-select"
              onchange="window.location.href=this.value"
              aria-label="${msg('selectLocale')}">
        <#list locale.supported as l>
          <option value="${l.url?no_esc}"<#if l.languageTag == currentLang> selected</#if>>${l.label}</option>
        </#list>
      </select>
    </div>
  </#if>

  <footer class="gv-auth-footer">
    Powered by <strong>Givernance</strong>
  </footer>
</div>

<#-- Required scripts from Keycloak (TOTP, WebAuthn, etc.) -->
<#if scripts??>
  <#list scripts as script>
    <script src="${script}" type="text/javascript"></script>
  </#list>
</#if>

<#-- M7: i18n strings for client-side JS (password-show/hide toggles).
     Injected from FreeMarker so the correct locale is used without hard-coding
     French (or any other language) into the JS source. -->
<script>
  window.gvI18n = {
    showPassword:        '${msg("showPassword")?js_string}',
    hidePassword:        '${msg("hidePassword")?js_string}',
    showPasswordConfirm: '${msg("showPasswordConfirm")?js_string}',
    hidePasswordConfirm: '${msg("hidePasswordConfirm")?js_string}'
  };
</script>

<#-- Auto-apply kc_locale hint from URL.
     The app passes kc_locale=<lang> in the OIDC auth URL so Keycloak picks
     up the user's language selection. Keycloak forwards the param to the
     login-actions URL, but in KC 26 the KEYCLOAK_LOCALE cookie takes
     precedence over the URL param during page rendering — so a stale cookie
     overrides the hint. This script detects the mismatch and navigates to
     the Keycloak locale-switch URL (l.url) for the requested locale, which
     updates the cookie and re-renders the page correctly. One redirect at
     most — after the switch, kc_locale matches currentLang and the guard
     short-circuits. -->
<#if locale?? && locale.supported?? && (locale.supported?size > 1)>
<script>
  (function () {
    var params = new URLSearchParams(window.location.search);
    var requested = params.get('kc_locale');
    if (!requested || requested === '${currentLang?js_string}') return;
    <#list locale.supported as l>
    if ('${(l.languageTag!'')?js_string}' === requested) {
      window.location.replace('${l.url?js_string?no_esc}');
      return;
    }
    </#list>
  }());
</script>
</#if>

</body>
</html>
</#macro>
