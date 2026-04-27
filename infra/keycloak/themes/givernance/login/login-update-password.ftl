<#--
  Givernance — Keycloak Login Theme — login-update-password.ftl
  Shown during first login after invitation: the user sets their new password.
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout; section>

  <#if section = "header">
    ${msg("updatePasswordTitle")}

  <#elseif section = "form">
    <form id="kc-passwd-update-form" class="gv-form"
          action="${url.loginAction?html}" method="post">

      <#-- Hidden username for password-manager association -->
      <input type="text" id="username" name="username" value="${username?html}"
             readonly autocomplete="username"
             style="display:none;position:absolute;left:-9999px;">

      <div class="gv-field">
        <label for="password-new" class="gv-label">${msg("passwordNew")}</label>
        <div class="gv-password-wrapper">
          <input
            id="password-new"
            name="password-new"
            type="password"
            class="gv-input<#if messagesPerField.existsError('password-new','password-confirm')> gv-input--error</#if>"
            autofocus
            autocomplete="new-password"
            tabindex="1"
            aria-invalid="${messagesPerField.existsError('password-new','password-confirm')?string('true','false')}"
          >
          <button type="button" class="gv-password-toggle"
                  onclick="toggleGvPassword('password-new')"
                  aria-label="Afficher le mot de passe" tabindex="5">
            <svg class="gv-eye-icon" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
        <#if messagesPerField.existsError('password-new')>
          <span class="gv-field-error" role="alert">
            ${kcSanitize(messagesPerField.getFirstError('password-new'))?no_esc}
          </span>
        </#if>
      </div>

      <div class="gv-field">
        <label for="password-confirm" class="gv-label">${msg("passwordConfirm")}</label>
        <div class="gv-password-wrapper">
          <input
            id="password-confirm"
            name="password-confirm"
            type="password"
            class="gv-input<#if messagesPerField.existsError('password-confirm')> gv-input--error</#if>"
            autocomplete="new-password"
            tabindex="2"
            aria-invalid="${messagesPerField.existsError('password-confirm')?string('true','false')}"
          >
          <button type="button" class="gv-password-toggle"
                  onclick="toggleGvPassword('password-confirm')"
                  aria-label="Afficher la confirmation" tabindex="6">
            <svg class="gv-eye-icon" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
        <#if messagesPerField.existsError('password-confirm')>
          <span class="gv-field-error" role="alert">
            ${kcSanitize(messagesPerField.getFirstError('password-confirm'))?no_esc}
          </span>
        </#if>
      </div>

      <#if isAppInitiatedAction??>
        <div style="display:flex;gap:12px;">
          <button type="submit" class="gv-btn gv-btn--primary"
                  id="kc-form-buttons" tabindex="3"
                  style="flex:1;">
            ${msg("doSubmit")}
          </button>
          <button type="submit" class="gv-btn gv-btn--secondary"
                  id="cancelBtn" name="cancel-aia" value="true" tabindex="4"
                  style="flex:1;">
            ${msg("doCancel")}
          </button>
        </div>
      <#else>
        <button type="submit" class="gv-btn gv-btn--primary"
                id="kc-form-buttons" tabindex="3">
          ${msg("doSubmit")}
        </button>
      </#if>
    </form>

    <script>
      function toggleGvPassword(id) {
        var input = document.getElementById(id);
        input.type = input.type === 'password' ? 'text' : 'password';
      }
    </script>
  </#if>

</@layout.registrationLayout>
