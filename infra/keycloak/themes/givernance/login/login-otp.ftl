<#--
  Givernance — Keycloak Login Theme — login-otp.ftl
  ============================================================
  Step-up MFA OTP entry (issue #250).

  Two reasons we override the parent template instead of inheriting it:

  1. Error feedback. The parent KC theme renders per-field errors via the
     `js/login.js` script (it injects `#input-error-{field}` spans on
     submit). theme.properties on this theme intentionally clears
     `scripts=` to avoid double-rendered errors on the templates we DO
     own — which means an inherited `login-otp.ftl` would silently swallow
     `messagesPerField.getFirstError('totp')` and the user would see an
     empty field with no feedback after typing a wrong code (PR #251
     dev-feedback).

  2. Device label visibility. KC's stock template hides the credential
     label when the user has a single OTP credential — only the radio
     picker for multi-credential cases shows the `userLabel`. Operators
     who enrolled "iPhone-personal" months ago need to know which device
     to grab when they're back. We render the label unconditionally.
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('totp'); section>

  <#if section = "header">
    ${msg("loginTotpTitle")}

  <#elseif section = "form">
    <form id="kc-otp-login-form" class="gv-form"
          action="${url.loginAction}" method="post">

      <#-- Credential picker / device label.
           When multiple credentials are enrolled, render a radio list so
           the operator can pick the device whose code they're typing.
           When only one is enrolled, just surface the userLabel as a
           read-only line so they remember which device they registered. -->
      <#if otpLogin.userOtpCredentials??>
        <#if (otpLogin.userOtpCredentials?size > 1)>
          <fieldset class="gv-field" id="kc-otp-credential-picker">
            <legend class="gv-label">${msg("loginOtpDeviceLabel")}</legend>
            <#list otpLogin.userOtpCredentials as otpCredential>
              <label class="gv-radio-label" for="kc-otp-credential-${otpCredential?index}">
                <input
                  id="kc-otp-credential-${otpCredential?index}"
                  type="radio"
                  name="selectedCredentialId"
                  value="${otpCredential.id}"
                  class="gv-radio"
                  <#if otpCredential.id == otpLogin.selectedCredentialId>checked</#if>
                >
                <span>${otpCredential.userLabel}</span>
              </label>
            </#list>
          </fieldset>
        <#elseif (otpLogin.userOtpCredentials?size == 1) && otpLogin.userOtpCredentials[0].userLabel?has_content>
          <#-- Single credential — show the label as a passive line so the
               operator can confirm which device the code should come from.
               Submit the credential id as a hidden input so KC's flow
               receives the same shape it would in the multi-credential
               case (defence against an empty `selectedCredentialId` on
               edge KC versions). -->
          <div class="gv-field">
            <span class="gv-label">${msg("loginOtpDeviceLabel")}</span>
            <p class="gv-otp-device" aria-live="polite">
              ${otpLogin.userOtpCredentials[0].userLabel}
            </p>
          </div>
          <input type="hidden" name="selectedCredentialId"
                 value="${otpLogin.userOtpCredentials[0].id}">
        </#if>
      </#if>

      <#-- One-time code input. -->
      <div class="gv-field">
        <label for="otp" class="gv-label">${msg("loginOtpOneTime")}</label>
        <input
          id="otp"
          name="otp"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          autofocus
          class="gv-input<#if messagesPerField.existsError('totp')> gv-input--error</#if>"
          aria-invalid="${messagesPerField.existsError('totp')?string('true','false')}"
        >
        <#if messagesPerField.existsError('totp')>
          <span class="gv-field-error" role="alert">
            ${kcSanitize(messagesPerField.getFirstError('totp'))?no_esc}
          </span>
        </#if>
      </div>

      <#-- Submit -->
      <button type="submit" class="gv-btn gv-btn--primary"
              id="kc-login" name="login">
        ${msg("doLogIn")}
      </button>
    </form>
  </#if>

</@layout.registrationLayout>
