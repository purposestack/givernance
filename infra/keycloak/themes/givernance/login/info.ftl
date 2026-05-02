<#--
  Givernance — Keycloak Login Theme — info.ftl
  Shown after successful actions that don't redirect immediately (e.g., email
  sent for verification / password reset). Wraps the KC info state in the
  Givernance layout instead of the default shell.
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=true; section>

  <#if section = "header">
    ${msg("infoTitle")}

  <#elseif section = "form">
    <#if requiredActions??>
      <ul style="margin:0 0 16px;padding-left:20px;font-size:0.875rem;color:var(--gv-text-secondary);line-height:1.6;">
        <#list requiredActions as reqAction>
          <li>${msg("requiredAction.${reqAction}")}</li>
        </#list>
      </ul>
    </#if>

    <#if skipLink?? && skipLink>
      <#-- KC asked us to skip the action link (e.g. already handled). -->
    <#elseif actionUri?has_content>
      <a class="gv-btn gv-btn--primary" href="${actionUri}">
        ${msg("proceedWithAction")}
      </a>
    </#if>

    <#--
      Back-to-login link.

      Pre-PR-#253-smoke-fix: this rendered `${url.loginUrl}`, which is a
      `/realms/{realm}/login-actions/...` URL that requires the auth
      session cookie. After an `execute-actions-email` UPDATE_PASSWORD
      flow, KC has consumed that cookie — clicking the link landed the
      user on a "Restart login cookie not found" error page.

      Resolution chain:
        1. `client.baseUrl` if the email passed `client_id` AND the
           client has an absolute `baseUrl` configured. Stable, doesn't
           depend on auth-session state. (Same posture error.ftl uses.)
        2. `properties.gvAppLoginUrl` from theme.properties — a
           hardcoded SPA login URL per environment. The dev value
           lives in `theme.properties`.
        3. No link at all. The user closes the window and navigates
           manually. Defensive — info.ftl never errors.
    -->
    <#if !(skipLink?? && skipLink)>
      <#if client?? && client.baseUrl?has_content>
        <a class="gv-link" href="${client.baseUrl}"
           style="display:block;text-align:center;margin-top:12px;font-size:0.8125rem;">
          ${msg("backToLogin")}
        </a>
      <#elseif properties.gvAppLoginUrl?? && properties.gvAppLoginUrl?has_content>
        <a class="gv-link" href="${properties.gvAppLoginUrl}"
           style="display:block;text-align:center;margin-top:12px;font-size:0.8125rem;">
          ${msg("backToLogin")}
        </a>
      </#if>
    </#if>
  </#if>

</@layout.registrationLayout>
