<#--
  Givernance — Keycloak Login Theme — info.ftl
  Shown after successful actions that don't redirect immediately (e.g.,
  email sent for verification / password reset). Wraps the KC info
  state in the Givernance layout instead of the default shell.
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
      Back-to-login button.

      Pre-PR-#253-smoke-fix this rendered `${url.loginUrl}`, which is a
      `/realms/{realm}/login-actions/...` URL that requires the auth
      session cookie. After an `execute-actions-email` UPDATE_PASSWORD
      flow KC has consumed that cookie — clicking the link landed the
      user on a "Restart login cookie not found" error page.

      Resolution chain:
        1. `client.baseUrl` if a `client_id` was scoped on the action
           AND the client has an absolute `baseUrl`. Stable, doesn't
           depend on auth-session state.
        2. `properties.gvAppLoginUrl` from `theme.properties`.
        3. Hardcoded dev fallback `http://localhost:3000/login`. KC's
           per-process theme cache makes (2) unreliable across container
           restarts; the hardcode guarantees a working button in dev
           regardless. Production deployments override this template
           (or set the property reliably) per environment.

      Rendered as a primary button so the user can't miss it — pre-fix
      the page just said "Your account has been updated" with no
      affordance to continue (caught in dev: PR #253 smoke-test feedback).
    -->
    <#if !(skipLink?? && skipLink)>
      <#assign gvBackUrl = "" />
      <#if client?? && client.baseUrl?has_content>
        <#assign gvBackUrl = client.baseUrl />
      <#elseif properties.gvAppLoginUrl?? && properties.gvAppLoginUrl?has_content>
        <#assign gvBackUrl = properties.gvAppLoginUrl />
      <#else>
        <#assign gvBackUrl = "http://localhost:3000/login" />
      </#if>
      <a class="gv-btn gv-btn--primary" href="${gvBackUrl}"
         style="display:block;text-align:center;margin-top:20px;">
        ${msg("backToLogin")}
      </a>
    </#if>
  </#if>

</@layout.registrationLayout>
