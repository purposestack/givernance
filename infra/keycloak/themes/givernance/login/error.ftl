<#--
  Givernance — Keycloak Login Theme — error.ftl
  Wraps Keycloak's generic error state in the Givernance layout.
  Covers flows that bypass the login form (OAuth errors, unexpected server
  errors, etc.) so users see the branded UI instead of the default KC shell.
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>

  <#if section = "header">
    ${msg("errorTitle")}

  <#elseif section = "form">
    <div class="gv-error-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    </div>

    <#if message?has_content>
      <p class="gv-error-detail">${kcSanitize(message.summary)?no_esc}</p>
    </#if>

    <#if skipLink?? && skipLink>
      <#-- Skip link: no back-to-login button (KC asked us to omit it). -->
    <#elseif client?? && client.baseUrl?has_content>
      <a class="gv-btn gv-btn--secondary" href="${client.baseUrl}">
        ${msg("backToApplication")}
      </a>
    <#else>
      <a class="gv-btn gv-btn--secondary" href="${url.loginUrl}">
        ${msg("backToLogin")}
      </a>
    </#if>
  </#if>

</@layout.registrationLayout>
