package kz.ts.owner;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * «Подписаться в ntfy» in the cabinet is an ntfy:// link. Capacitor opens it with an intent and
 * silently does nothing when the ntfy app is missing; here the owner lands on its store page instead.
 */
@CapacitorPlugin(name = "NtfyLinks")
public class NtfyLinksPlugin extends Plugin {

    private static final String STORE = "market://details?id=io.heckel.ntfy";
    // No store app at all (a phone without Google Play or F-Droid): the F-Droid page in the browser.
    private static final String WEB = "https://f-droid.org/packages/io.heckel.ntfy/";

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (!"ntfy".equals(url.getScheme())) return null;
        if (!open(url) && !open(Uri.parse(STORE))) open(Uri.parse(WEB));
        return true;
    }

    private boolean open(Uri uri) {
        try {
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri));
            return true;
        } catch (ActivityNotFoundException e) {
            return false;
        }
    }
}
