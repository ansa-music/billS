package kz.ts.owner;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins are registered before the bridge starts in super.onCreate.
        registerPlugin(NtfyLinksPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
