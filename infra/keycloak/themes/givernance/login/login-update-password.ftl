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
          action="${url.loginAction}" method="post">

      <#-- Hidden username for password-manager association.
           Positioned off-screen (not display:none) so password managers
           can read the autocomplete hint; aria-hidden keeps it silent
           to screen readers. -->
      <input type="text" id="username" name="username" value="${username}"
             readonly autocomplete="username" aria-hidden="true"
             style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;">

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
            aria-invalid="${messagesPerField.existsError('password-new','password-confirm')?string('true','false')}"
          >
          <button type="button" class="gv-password-toggle"
                  onclick="toggleGvPassword('password-new')"
                  aria-label="${msg('showPassword')}">
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
            aria-invalid="${messagesPerField.existsError('password-confirm')?string('true','false')}"
          >
          <button type="button" class="gv-password-toggle"
                  onclick="toggleGvPassword('password-confirm')"
                  aria-label="${msg('showPasswordConfirm')}">
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
                  id="kc-form-buttons" style="flex:1;">
            ${msg("doSubmit")}
          </button>
          <button type="submit" class="gv-btn gv-btn--secondary"
                  id="cancelBtn" name="cancel-aia" value="true" style="flex:1;">
            ${msg("doCancel")}
          </button>
        </div>
      <#else>
        <button type="submit" class="gv-btn gv-btn--primary"
                id="kc-form-buttons">
          ${msg("doSubmit")}
        </button>
      </#if>
    </form>

    <script>
      function toggleGvPassword(id) {
        var input = document.getElementById(id);
        var btn   = input.nextElementSibling;
        var i18n  = window.gvI18n || {};
        var isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        if (id === 'password-confirm') {
          btn.setAttribute('aria-label', isPassword ? (i18n.hidePasswordConfirm || 'Hide') : (i18n.showPasswordConfirm || 'Show'));
        } else {
          btn.setAttribute('aria-label', isPassword ? (i18n.hidePassword || 'Hide') : (i18n.showPassword || 'Show'));
        }
      }
    </script>
  </#if>

</@layout.registrationLayout>
