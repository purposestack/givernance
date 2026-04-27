<#--
  Givernance — Keycloak Login Theme — login-verify-email.ftl
  Shown after registration / invitation: prompts the user to check their inbox.
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>

  <#if section = "header">
    ${msg("emailVerifyTitle")}

  <#elseif section = "form">
    <div style="text-align:center;">
      <#-- Envelope icon -->
      <div class="gv-verify-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="4" width="20" height="16" rx="2"/>
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
        </svg>
      </div>

      <p style="font-size:0.875rem;color:#3f4943;margin-bottom:8px;line-height:1.6;">
        ${msg("emailVerifyInstruction1", user.email!'')}
      </p>
      <p style="font-size:0.8125rem;color:#6f7a73;line-height:1.6;margin-bottom:20px;">
        ${msg("emailVerifyInstruction2")}
      </p>
      <p style="font-size:0.8125rem;color:#6f7a73;line-height:1.6;">
        ${msg("emailVerifyInstruction3")}
        <a class="gv-link" href="${url.loginAction?html}">
          ${msg("emailVerifyInstruction3link")}
        </a>
      </p>
    </div>
  </#if>

</@layout.registrationLayout>
