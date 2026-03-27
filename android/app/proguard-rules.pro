# Capacitor ProGuard Rules
# https://capacitorjs.com/docs/android/troubleshooting#proguard-rules
-keep class com.getcapacitor.** { *; }
-keep interface com.getcapacitor.** { *; }
-keep class com.getcapacitor.Bridge { *; }
-keep class * extends com.getcapacitor.Plugin { *; }
-keep class * extends com.getcapacitor.BridgePlugin { *; }
-keep class * extends com.getcapacitor.cordova.CorruptlyPlugin { *; }

# Google Services/Firebase rules (if applicable)
-keep class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }

# Standard optimization rules
-dontwarn okio.**
-dontwarn javax.annotation.**
-keepattributes Signature, InnerClasses, EnclosingMethod, AnnotationDefault, RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations
-keepclassmembers class * {
    @com.getcapacitor.CapacitorPlugin *;
    @com.getcapacitor.PluginMethod *;
}
