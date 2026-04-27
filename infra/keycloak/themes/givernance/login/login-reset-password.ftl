<#--
  Givernance — Keycloak Login Theme — login-reset-password.ftl
  Forgot-password flow: the user enters their email to receive a reset link.
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout
    displayInfo=true
    displayMessage=!messagesPerField.existsError("username");
    section>

  <#if section = "header">
    ${msg("emailForgotTitle")}

  <#elseif section = "form">
    <form id="kc-reset-password-form" class="gv-form"
          action="${url.loginAction}" method="post">

      <div class="gv-field">
        <label for="username" class="gv-label">
          <#if !realm.loginWithEmailAllowed>
            ${msg("username")}
          <#elseif !realm.registrationEmailAsUsername>
            ${msg("usernameOrEmail")}
          <#else>
            ${msg("email")}
          </#if>
        </label>
        <input
          id="username"
          name="username"
          type="text"
          class="gv-input<#if messagesPerField.existsError('username')> gv-input--error</#if>"
          value="${(auth.attemptedUsername!'')}"
          autofocus
          autocomplete="email"
          tabindex="1"
          aria-invalid="${messagesPerField.existsError('username')?string('true','false')}"
        >
        <#if messagesPerField.existsError('username')>
          <span class="gv-field-error" role="alert">
            ${kcSanitize(messagesPerField.getFirstError('username'))?no_esc}
          </span>
        </#if>
      </div>

      <button type="submit" class="gv-btn gv-btn--primary" tabindex="2">
        ${msg("doSubmit")}
      </button>

      <a class="gv-link" href="${url.loginUrl}"
         style="display:block;text-align:center;margin-top:4px;font-size:0.8125rem;">
        ${msg("backToLogin")}
      </a>
    </form>

  <#elseif section = "info">
    ${msg("emailForgotInstruction")}
  </#if>

</@layout.registrationLayout>
