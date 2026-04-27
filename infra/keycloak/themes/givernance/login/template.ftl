<#--
  Givernance — Keycloak Login Theme — template.ftl
  ============================================================
  Main layout macro used by every login page in this theme.
  Supports per-org branding via Keycloak 26 Organization attributes:
    - theme_primary_color  : hex color for primary actions (default: #096447)
    - logo_url             : public URL of the org logo (optional)
  Both are non-sensitive public values and safe to store in Organization
  attributes (see CLAUDE.md — "No secrets in Keycloak Organization attributes").

  Pattern 1 (subdomain-first): the app passes kc_org=<alias> derived from the
  Host header, which resolves the Organization and populates ${organization}.
-->
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>

<#-- Resolve per-org branding from Organization attributes (KC 26). -->
<#assign gvPrimary      = "#096447">
<#assign gvPrimaryHover = "#005138">
<#assign gvOrgLogoUrl   = "">
<#assign gvOrgName      = (realm.displayName)!"Givernance">
<#if organization??>
  <#if (organization.attributes['theme_primary_color']![])?has_content>
    <#assign gvPrimary      = organization.attributes['theme_primary_color']?first>
    <#-- Darken slightly for hover: blend to #000 — approximated with a darker literal fallback. -->
    <#-- Real per-org hover can be added via JS color-mix if needed. -->
    <#assign gvPrimaryHover = gvPrimary>
  </#if>
  <#if (organization.attributes['logo_url']![])?has_content>
    <#assign gvOrgLogoUrl = organization.attributes['logo_url']?first>
  </#if>
  <#if organization.name?has_content>
    <#assign gvOrgName = organization.name>
  </#if>
</#if>

<!DOCTYPE html>
<html lang="${locale.currentLanguageTag}" dir="ltr">
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
<div class="gv-auth-page">
  <div class="gv-auth-card">

    <#-- Locale picker (when multiple locales are configured) -->
    <#if locale.supported?size gt 1>
      <div class="gv-locale-picker">
        <select class="gv-locale-select" onchange="window.location.href=this.value" aria-label="Language">
          <#list locale.supported as l>
            <option value="${l.url}" <#if l.active>selected</#if>>${l.label}</option>
          </#list>
        </select>
      </div>
    </#if>

    <#-- Logo / brand -->
    <div class="gv-auth-header">
      <#if gvOrgLogoUrl?has_content>
        <img src="${gvOrgLogoUrl?html}" alt="${gvOrgName?html}" class="gv-org-logo">
        <p class="gv-org-name">${gvOrgName?html}</p>
      <#else>
        <div class="gv-brand-logo">
          <svg viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg"
               class="gv-logo-svg" aria-hidden="true" focusable="false">
            <defs>
              <linearGradient id="lg-bird" x1="0" y1="0" x2="256" y2="200" gradientUnits="userSpaceOnUse">
                <stop offset="0%"   stop-color="#A5DEC2"/>
                <stop offset="50%"  stop-color="#55C6AF"/>
                <stop offset="100%" stop-color="#2E7D5E"/>
              </linearGradient>
              <linearGradient id="lg-hand" x1="40" y1="140" x2="220" y2="256" gradientUnits="userSpaceOnUse">
                <stop offset="0%"   stop-color="#F88B71"/>
                <stop offset="100%" stop-color="#EC6A66"/>
              </linearGradient>
            </defs>
            <g transform="translate(0,256) scale(0.1,-0.1)">
              <path fill="url(#lg-bird)" d="M62 2528 c-6 -18 -14 -49 -17 -68 -3 -19 -11 -53 -17 -75 -34 -129 -30 -490 7 -594 8 -22 13 -41 11 -41 -9 0 49 -152 84 -222 65 -129 138 -228 252 -340 59 -60 112 -108 117 -108 5 0 16 -6 24 -14 51 -51 335 -196 384 -196 12 0 27 41 38 103 3 21 8 44 11 52 4 9 -32 31 -108 68 -239 117 -420 298 -528 531 -36 78 -51 124 -80 244 -24 102 -29 352 -7 352 7 0 44 -21 82 -46 65 -42 211 -127 350 -204 33 -19 123 -65 200 -103 342 -171 536 -295 632 -403 113 -126 168 -299 132 -413 -22 -69 -43 -116 -71 -158 -15 -23 -28 -46 -28 -51 0 -12 66 -27 158 -38 72 -8 58 -19 151 116 52 76 141 275 141 317 0 15 59 138 84 175 26 40 103 85 176 104 51 13 91 15 188 11 74 -4 122 -2 122 4 0 11 -152 125 -179 134 -11 3 -30 27 -42 52 -65 134 -234 202 -431 173 -91 -13 -141 -30 -208 -72 -119 -73 -146 -88 -165 -88 -24 0 -41 9 -225 115 -74 42 -214 117 -310 165 -184 91 -411 215 -459 250 -16 11 -32 20 -35 20 -3 0 -58 35 -122 78 -159 106 -153 101 -221 155 -34 26 -65 47 -70 47 -5 0 -14 -15 -21 -32z"/>
              <path fill="url(#lg-hand)" d="M2290 743 c-42 -8 -159 -68 -270 -138 -202 -127 -374 -212 -510 -252 -84 -25 -299 -22 -409 6 -46 11 -85 21 -87 21 -2 0 -4 4 -4 10 0 13 87 56 130 64 19 3 107 13 195 21 141 13 167 19 222 45 63 31 123 90 123 122 0 23 -12 25 -215 38 -93 6 -181 13 -195 16 -147 26 -456 31 -581 9 -215 -37 -373 -117 -509 -256 -81 -82 -154 -215 -165 -299 -13 -99 -16 -138 -8 -143 4 -2 41 9 81 25 128 51 229 68 382 64 130 -4 173 -9 475 -57 181 -28 415 -31 525 -7 194 44 323 108 585 292 16 11 55 40 85 64 66 51 48 37 200 151 205 155 219 166 219 172 3 25 -191 48 -269 32z"/>
            </g>
          </svg>
          <span class="gv-brand-name">Givernance</span>
        </div>
        <#if organization?? && gvOrgName != "Givernance">
          <p class="gv-org-name">${gvOrgName?html}</p>
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

  <footer class="gv-auth-footer">
    Propuls&eacute; par <strong>Givernance</strong>
  </footer>
</div>

<#-- Required scripts from Keycloak (TOTP, WebAuthn, etc.) -->
<#if scripts??>
  <#list scripts as script>
    <script src="${script}" type="text/javascript"></script>
  </#list>
</#if>

</body>
</html>
</#macro>
