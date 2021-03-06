import {
	Component,
	Input,
	Output,
	OnChanges,
	OnDestroy,
	EventEmitter,
	NgModule,
	ViewContainerRef,
	ComponentRef,
	ModuleWithComponentFactories,
	ComponentFactory,
	Type,
	ReflectiveInjector,
	SimpleChanges,
	NgModuleRef,
	NgModuleFactoryLoader,
	NgModuleFactory,
	Compiler
} from '@angular/core';

import { CommonModule } from '@angular/common';
import { Http, Response, RequestOptionsArgs } from '@angular/http';
import { Observable } from 'rxjs';

import { Utils } from './dynamic.utils';
import { DynamicCache } from './dynamic.cache';
import {
	IDynamicRemoteTemplateFactory,
	IDynamicTemplateMetadata,
	IDynamicTemplatePlaceholder,
	IDynamicTemplateContext,
	AnyT,
	ILazyRoute,
	HASH_FIELD,
	IDynamicComponentConfig
} from './dynamic.interface';

export class DynamicBase implements OnChanges, OnDestroy {

	@Output() templateReady: EventEmitter<IDynamicTemplatePlaceholder>;

	@Input() template: string;
	@Input() lazyModules: string[];
	@Input() httpUrl: string;
	@Input() context: IDynamicTemplateContext;
	@Input() remoteTemplateFactory: IDynamicRemoteTemplateFactory;
	@Input() extraModules: any[];
	@Input() styles: string[];
	@Input() defaultTemplate: string;

	private lazyExtraModules: (AnyT|Function)[] = [];
	private injector:ReflectiveInjector;
	private dynamicSelector:string;
	private cachedDynamicModule:AnyT;
	private cachedTemplatePlaceholder:Type<IDynamicTemplatePlaceholder>;
	private templatePlaceholder: ComponentRef<IDynamicTemplatePlaceholder>;
	private moduleInstance: NgModuleRef<any>;

	constructor(protected dynamicExtraModules: Array<any>,
	            protected dynamicResponseRedirectStatuses: number[],
	            protected viewContainer: ViewContainerRef,
	            protected compiler: Compiler,
	            protected http: Http,
	            protected dynamicCache: DynamicCache,
	            protected moduleFactoryLoader: NgModuleFactoryLoader,
	            protected routes: ILazyRoute[],
	            dynamicSelector: string) {
		this.templateReady = new EventEmitter<IDynamicTemplatePlaceholder>();
		this.dynamicSelector = Utils.buildByNextId(dynamicSelector);

		this.injector = ReflectiveInjector.fromResolvedProviders([], this.viewContainer.parentInjector);
	}

	/**
	 * @override
	 */
	public ngOnChanges(changes: SimpleChanges) {
		this.ngOnDestroy();

		// TODO investigate memory leak in the specific case
		this.buildModule().then((module: AnyT) => {
				let compiledModule: Promise<ModuleWithComponentFactories<any>>;
				const currentModuleHash: string = Reflect.get(module, HASH_FIELD);

				if (Utils.isPresent(currentModuleHash)) {
					compiledModule = this.dynamicCache.get(currentModuleHash);
					if (!Utils.isPresent(compiledModule)) {
						this.dynamicCache.set(currentModuleHash, compiledModule = this.compiler.compileModuleAndAllComponentsAsync<any>(module));
					}
				} else {
					compiledModule = this.compiler.compileModuleAndAllComponentsAsync<any>(module);
				}

				compiledModule
					.then((compiledModule: ModuleWithComponentFactories<any>) => this.makeDynamicTemplatePlaceholder(compiledModule))
			}
		);
	}

	/**
	 * @override
	 */
	public ngOnDestroy() {
		if (Utils.isPresent(this.moduleInstance)) {
			this.moduleInstance.destroy();
			this.moduleInstance = null;
		}
		if (Utils.isPresent(this.templatePlaceholder)) {
			this.templatePlaceholder.destroy();
			this.templatePlaceholder = null;
		}
		if (Utils.isPresent(this.cachedDynamicModule)) {
			this.compiler.clearCacheFor(this.cachedDynamicModule);
			this.cachedDynamicModule = null;
		}
		if (Utils.isPresent(this.cachedTemplatePlaceholder)) {
			this.compiler.clearCacheFor(this.cachedTemplatePlaceholder);
			this.cachedTemplatePlaceholder = null;
		}
	}

	private makeDynamicTemplatePlaceholder(moduleWithComponentFactories: ModuleWithComponentFactories<any>) {
		this.moduleInstance = moduleWithComponentFactories.ngModuleFactory.create(this.injector);

		const factory = moduleWithComponentFactories.componentFactories.find((componentFactory: ComponentFactory<AnyT>) => {
				return componentFactory.selector === this.dynamicSelector
					|| (Utils.isPresent(componentFactory.componentType) && Utils.isPresent(this.template)
					&& Reflect.get(componentFactory.componentType, HASH_FIELD) === Utils.hashFnv32a(this.template, true));
			}
		);

		const templatePlaceholder = this.templatePlaceholder = factory.create(this.injector, null, null, this.moduleInstance);
		this.viewContainer.insert(templatePlaceholder.hostView, 0);
		this.applyPropertiesToDynamicTemplatePlaceholder(this.templatePlaceholder.instance);

		this.templateReady.emit(this.templatePlaceholder.instance);
	}

	private buildModule(): Promise<AnyT> {
		const lazyModules: string[] = [].concat(this.lazyModules || []);
		const lazyModulesLoaders: Promise<NgModuleFactory<any>|Function>[] = [];

		for (let lazyModule of lazyModules) {
			const lazyRoute: ILazyRoute = Utils.findLazyRouteLoader(lazyModule, this.routes);
			if (lazyRoute) {
				if (Utils.isFunction(lazyRoute.loadChildren)) {
					// angular2-class starter
					lazyModulesLoaders.push(
						Observable.of((lazyRoute.loadChildren as Function)()).toPromise()
					);
				} else {
					// angular-cli
					lazyModulesLoaders.push(this.moduleFactoryLoader.load(lazyRoute.loadChildren as string));
				}
			} else {
				lazyModulesLoaders.push(this.moduleFactoryLoader.load(lazyModule));
			}
		}
		return new Promise((resolve: (value: AnyT) => void) => {
			Promise.all(lazyModulesLoaders)
				.then((moduleFactories: (NgModuleFactory<any>|Function)[]) => {
					for (let moduleFactory of moduleFactories) {
						if (moduleFactory instanceof NgModuleFactory) {
							// angular-cli
							this.lazyExtraModules.push(moduleFactory.moduleType);
						} else {
							// angular2-class starter
							this.lazyExtraModules.push(moduleFactory);
						}
					}
					if (Utils.isPresent(this.template)) {
						resolve(this.makeComponentModule({template: this.template}));
					} else if (Utils.isPresent(this.httpUrl)) {
						this.loadRemoteTemplate(this.httpUrl, resolve);
					} else {
						resolve(this.makeComponentModule());
					}
				});
		});
	}

	private loadRemoteTemplate(httpUrl: string, resolve: (value: AnyT) => void) {
		let requestArgs: RequestOptionsArgs = {withCredentials: true};
		if (Utils.isPresent(this.remoteTemplateFactory)
			&& Utils.isFunction(this.remoteTemplateFactory.buildRequestOptions)) {
			requestArgs = this.remoteTemplateFactory.buildRequestOptions();
		}

		this.http.get(httpUrl, requestArgs)
			.subscribe((response: Response) => {
				if (this.dynamicResponseRedirectStatuses.indexOf(response.status) > -1) {
					const chainedUrl: string = response.headers.get('Location');
					if (Utils.isPresent(chainedUrl)) {
						this.loadRemoteTemplate(chainedUrl, resolve);
					}
				} else {
					const loadedTemplate: string = Utils.isPresent(this.remoteTemplateFactory)
					&& Utils.isFunction(this.remoteTemplateFactory.parseResponse)
						? this.remoteTemplateFactory.parseResponse(response)
						: response.text();

					resolve(this.makeComponentModule({template: loadedTemplate}));
				}
			}, () => {
				const template: string = this.defaultTemplate || '';
				resolve(this.makeComponentModule({template: template}));
			});
	}

	private makeComponentModule(dynamicConfig?: IDynamicComponentConfig): AnyT {
		const dynamicComponentType: Type<IDynamicTemplatePlaceholder>
			= this.cachedTemplatePlaceholder
			= this.makeComponent(dynamicConfig);

		const modules: any[] = this.dynamicExtraModules
			.concat(this.extraModules || [])
			.concat(this.lazyExtraModules);

		@NgModule({
			declarations: [dynamicComponentType],
			imports: [CommonModule].concat(modules)
		})
		class dynamicComponentModule {
		}

		const dynamicComponentTypeHash: string = Reflect.get(dynamicComponentType, HASH_FIELD);
		if (Utils.isPresent(dynamicComponentTypeHash)) {
			Reflect.set(dynamicComponentModule, HASH_FIELD, dynamicComponentTypeHash);
		}
		return this.cachedDynamicModule = dynamicComponentModule;
	}

	private makeComponent(componentConfig?: IDynamicComponentConfig): Type<IDynamicTemplatePlaceholder> {
		const dynamicComponentMetaData: IDynamicTemplateMetadata = {
			selector: this.dynamicSelector,
			styles: this.styles
		};

		if (Utils.isPresent(componentConfig)) {
			if (Utils.isPresent(componentConfig.template)) {
				dynamicComponentMetaData.template = componentConfig.template;
			} else if (Utils.isPresent(componentConfig.templatePath)) {
				dynamicComponentMetaData.templateUrl = componentConfig.templatePath;
			}
		}

		@Component(dynamicComponentMetaData)
		class dynamicComponentClass {
		}

		if (Utils.isPresent(Reflect.get(dynamicComponentMetaData, 'template'))) {
			Reflect.set(dynamicComponentClass, HASH_FIELD, Utils.hashFnv32a(Reflect.get(dynamicComponentMetaData, 'template'), true));
		}
		return dynamicComponentClass as Type<IDynamicTemplatePlaceholder>;
	}

	private applyPropertiesToDynamicTemplatePlaceholder(instance: IDynamicTemplatePlaceholder) {
		if (!Utils.isPresent(this.context)) {
			return;
		}
		Utils.applySourceAttributes(instance, this.context);
	}
}
