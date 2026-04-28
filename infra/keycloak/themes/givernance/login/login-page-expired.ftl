<#--
  Givernance — Keycloak Login Theme — login-page-expired.ftl
  Shown when the user tries to submit a login form after its one-time token
  has expired (e.g. page left open overnight). Provides two recovery options:
    1. Restart the full flow from scratch (url.loginRestartFlowUrl)
    2. Continue from the last known step (url.loginAction)
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>

  <#if section = "header">
    ${msg("pageExpiredTitle")}

  <#elseif section = "form">
    <p class="gv-error-detail">
      ${msg("pageExpiredMsg1")}
      <a class="gv-link" href="${url.loginRestartFlowUrl}">${msg("doClickHere")}</a>
      ${msg("pageExpiredMsg2")}
      <a class="gv-link" href="${url.loginAction}">${msg("doClickHere")}</a>
      ${msg("pageExpiredMsg3")}
    </p>
  </#if>

</@layout.registrationLayout>
