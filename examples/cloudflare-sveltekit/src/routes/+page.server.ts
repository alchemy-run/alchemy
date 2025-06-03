import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	// Demonstrate KV Store usage
	const kv = platform?.env.AUTH_STORE;
	let kvData = null;
	
	if (kv) {
		try {
			// Try to get a value from KV
			kvData = await kv.get('demo-key');
			
			// If no value exists, set one
			if (!kvData) {
				await kv.put('demo-key', JSON.stringify({
					message: 'Hello from Cloudflare KV!',
					timestamp: new Date().toISOString()
				}));
				kvData = await kv.get('demo-key');
			}
		} catch (error) {
			console.error('KV error:', error);
		}
	}

	// Demonstrate R2 Storage info
	const r2 = platform?.env.STORAGE;
	let r2Info = null;
	
	if (r2) {
		try {
			// List objects in the bucket (up to 1000)
			const objects = await r2.list({ limit: 10 });
			r2Info = {
				bucketName: 'Storage bucket connected!',
				objectCount: objects.objects?.length || 0,
				objects: objects.objects?.map(obj => ({
					key: obj.key,
					size: obj.size,
					modified: obj.uploaded
				})) || []
			};
		} catch (error) {
			console.error('R2 error:', error);
			r2Info = { error: 'Failed to access R2 bucket' };
		}
	}

	return {
		kv: kvData ? JSON.parse(kvData) : null,
		r2: r2Info,
		platform: {
			hasKV: !!kv,
			hasR2: !!r2,
			hasContext: !!platform?.context
		}
	};
}; 