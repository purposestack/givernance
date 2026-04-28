<#--
  Givernance — Keycloak Login Theme — login.ftl
  Main sign-in form: email/username + password, remember-me, forgot-password link.
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout
    displayMessage=false
    displayInfo=realm.password && (social.providers)?has_content;
    section>

  <#if section = "header">
    ${msg("loginAccountTitle")}

  <#elseif section = "form">
    <form id="kc-form-login" class="gv-form"
          action="${url.loginAction}" method="post">

      <#-- Username / email field -->
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
          class="gv-input<#if messagesPerField.existsError('username','password')> gv-input--error</#if>"
          value="${(login.username!'')}"
          autofocus
          autocomplete="username"
          <#if usernameEditDisabled??>readonly</#if>
          aria-invalid="${messagesPerField.existsError('username','password')?string('true','false')}"
        >
        <#-- Show field error if KC tagged this field; otherwise fall back to
             the global message (e.g. "required" validation before auth even
             runs, account locked, etc.) so all errors use the same span style. -->
        <#if messagesPerField.existsError('username')>
          <span class="gv-field-error" role="alert">
            ${kcSanitize(messagesPerField.getFirstError('username'))?no_esc}
          </span>
        <#elseif message?has_content && message.type = "error">
          <span class="gv-field-error" role="alert">
            ${kcSanitize(message.summary)?no_esc}
          </span>
        </#if>
      </div>

      <#-- Password field -->
      <div class="gv-field">
        <div class="gv-label-row">
          <label for="password" class="gv-label">${msg("password")}</label>
          <#if realm.resetPasswordAllowed>
            <a class="gv-link gv-link--small" href="${url.loginResetCredentialsUrl}">
              ${msg("doForgotPassword")}
            </a>
          </#if>
        </div>
        <div class="gv-password-wrapper">
          <input
            id="password"
            name="password"
            type="password"
            class="gv-input<#if messagesPerField.existsError('username','password')> gv-input--error</#if>"
            autocomplete="current-password"
            aria-invalid="${messagesPerField.existsError('username','password')?string('true','false')}"
          >
          <button type="button" class="gv-password-toggle"
                  onclick="toggleGvPassword()"
                  aria-label="${msg('showPassword')}">
            <svg class="gv-eye-icon" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round"
                 aria-hidden="true">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
        <#if messagesPerField.existsError('password')>
          <span class="gv-field-error" role="alert">
            ${kcSanitize(messagesPerField.getFirstError('password'))?no_esc}
          </span>
        </#if>
      </div>

      <#-- Remember me -->
      <#if realm.rememberMe && !usernameEditDisabled??>
        <div class="gv-checkbox-row">
          <label class="gv-checkbox-label">
            <input
              id="rememberMe"
              name="rememberMe"
              type="checkbox"
              class="gv-checkbox"
              <#if login.rememberMe??>checked</#if>
            >
            <span>${msg("rememberMe")}</span>
          </label>
        </div>
      </#if>

      <#-- Hidden credential selector (for multi-credential flows) -->
      <input type="hidden" id="id-hidden-input" name="credentialId"
             <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>>

      <#-- Submit -->
      <button type="submit" class="gv-btn gv-btn--primary"
              id="kc-login" name="login">
        ${msg("doLogIn")}
      </button>
    </form>

    <script>
      function toggleGvPassword() {
        var input = document.getElementById('password');
        var btn   = input.nextElementSibling;
        if (input.type === 'password') {
          input.type = 'text';
          btn.setAttribute('aria-label', (window.gvI18n || {}).hidePassword || 'Hide password');
        } else {
          input.type = 'password';
          btn.setAttribute('aria-label', (window.gvI18n || {}).showPassword || 'Show password');
        }
      }
    </script>

  <#elseif section = "info">
    <#-- Social / identity provider buttons — only rendered when providers are
         actually configured. social.providers?? is true even for an empty list;
         ?has_content guards against showing the separator with no buttons. -->
    <#if realm.password && (social.providers)?has_content>
      <p style="margin-bottom:12px;font-size:0.8125rem;text-align:center;">
        ${msg("identity-provider-login-label")}
      </p>
      <#list social.providers as p>
        <a href="${p.loginUrl}" id="social-${p.alias}"
           class="gv-btn gv-btn--secondary" style="margin-bottom:8px;" rel="nofollow">
          <#if p.iconClasses??>
            <i class="${p.iconClasses}" aria-hidden="true" style="margin-right:8px;"></i>
          </#if>
          ${p.displayName!p.alias}
        </a>
      </#list>
    </#if>
  </#if>

</@layout.registrationLayout>
