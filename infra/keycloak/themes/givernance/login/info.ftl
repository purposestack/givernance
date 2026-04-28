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

    <#if !(skipLink?? && skipLink)>
      <a class="gv-link" href="${url.loginUrl}"
         style="display:block;text-align:center;margin-top:12px;font-size:0.8125rem;">
        ${msg("backToLogin")}
      </a>
    </#if>
  </#if>

</@layout.registrationLayout>
