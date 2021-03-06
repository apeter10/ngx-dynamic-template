import { NgModule, ModuleWithProviders, SystemJsNgModuleLoader, NgModuleFactoryLoader } from '@angular/core';

import { DynamicDirective } from './dynamic.directive';
import { DynamicCache } from './dynamic.cache';
import { DynamicTypes, IDynamicTemplateOptions, ROUTES_TOKEN } from './dynamic.interface';

@NgModule(
	{
		declarations: [
			DynamicDirective
		],
		exports: [
			DynamicDirective
		]
	}
)
export class NgxDynamicTemplateModule {

	static forRoot(options?: IDynamicTemplateOptions): ModuleWithProviders {
		return {
			ngModule: NgxDynamicTemplateModule,
			providers: [
				DynamicCache,
				{ provide: DynamicTypes.DynamicExtraModules, useValue: options && options.extraModules ? options.extraModules : [] },
				{ provide: DynamicTypes.DynamicResponseRedirectStatuses, useValue: [301, 302, 307, 308] },
				{ provide: NgModuleFactoryLoader, useClass: SystemJsNgModuleLoader },
				{ provide: ROUTES_TOKEN, useValue: options.routes || [] }
			]
		};
	}
}
